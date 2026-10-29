use super::*;
use crate::server_config;
use std::{collections::HashMap, net::TcpListener, path::PathBuf};

fn fixture(script: &str) -> (tempfile::TempDir, ServerConfig) {
	let root = tempfile::tempdir().unwrap();
	let source = root.path().join("source & workspace");
	fs::create_dir_all(source.join("apps/server/src")).unwrap();
	fs::write(source.join("apps/server/src/index.ts"), script).unwrap();
	let bun = Command::new("which").arg("bun").output().unwrap();
	assert!(bun.status.success(), "bun must be on PATH");
	let listener = TcpListener::bind("127.0.0.1:0").unwrap();
	let port = listener.local_addr().unwrap().port();
	let config = ServerConfig {
		executable: PathBuf::from(String::from_utf8(bun.stdout).unwrap().trim()),
		project_root: source,
		log_dir: root.path().join("logs"),
		env: HashMap::from([
			("PORT".into(), port.to_string()),
			("MARKER".into(), "inherited".into()),
		]),
	};
	(root, config)
}

const SERVER: &str = r#"
const fs = require('node:fs');
fs.appendFileSync('starts', 'start\n');
console.log(JSON.stringify({pid:process.pid, parent:process.ppid, owner:process.env.REVV_DESKTOP_PID, marker:process.env.MARKER, cwd:process.cwd()}));
const child = Bun.spawn(['sleep', '120']);
fs.writeFileSync('descendant', String(child.pid));
const app = Bun.serve({port: Number(process.env.PORT), hostname:'127.0.0.1', fetch:()=>new Response('ok')});
process.on('SIGTERM', () => { console.error('graceful shutdown'); app.stop(true); process.exit(0); });
if (process.env.CRASH) setTimeout(() => process.exit(1), 300);
"#;

fn assert_stopped(pid: u32) {
	for _ in 0..50 {
		let status = Command::new("ps")
			.args(["-o", "stat=", "-p", &pid.to_string()])
			.output()
			.unwrap();
		let status = String::from_utf8_lossy(&status.stdout);
		if status.trim().is_empty() || status.trim().starts_with('Z') {
			return;
		}
		thread::sleep(POLL_INTERVAL);
	}
	panic!("process {pid} survived shutdown");
}

#[test]
fn owns_the_server_environment_logs_and_process_group() {
	let (_root, config) = fixture(SERVER);
	let server = ServerProcess::start(config.clone(), |message| panic!("{message}")).unwrap();
	let log = fs::read_to_string(config.log_dir.join("server.out.log")).unwrap();
	let state: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
	assert_eq!(state["parent"], std::process::id());
	assert_eq!(state["owner"], std::process::id().to_string());
	assert_eq!(state["marker"], "inherited");
	assert_eq!(
		PathBuf::from(state["cwd"].as_str().unwrap())
			.canonicalize()
			.unwrap(),
		config.project_root.canonicalize().unwrap()
	);
	let descendant: u32 = fs::read_to_string(config.project_root.join("descendant"))
		.unwrap()
		.parse()
		.unwrap();
	server.stop();
	server.stop(); // Exit hooks and Drop may both run.
	assert_stopped(state["pid"].as_u64().unwrap().try_into().unwrap());
	assert_stopped(descendant);
	assert!(fs::read_to_string(config.log_dir.join("server.err.log"))
		.unwrap()
		.contains("graceful shutdown"));
	assert!(!healthy(SocketAddr::from((
		[127, 0, 0, 1],
		config.port().unwrap()
	))));
}

#[test]
fn restarts_crashes_with_a_finite_budget() {
	let (_root, mut config) = fixture(SERVER);
	config.env.insert("CRASH".into(), "1".into());
	let (failed, result) = mpsc::channel();
	let server = ServerProcess::start(config.clone(), move |message| {
		failed.send(message).unwrap();
	})
	.unwrap();
	let message = result.recv_timeout(Duration::from_secs(15)).unwrap();
	assert!(message.contains("3 restart attempts"), "{message}");
	assert_eq!(
		fs::read_to_string(config.project_root.join("starts"))
			.unwrap()
			.lines()
			.count(),
		4
	);
	server.stop();
	let descendant = fs::read_to_string(config.project_root.join("descendant"))
		.unwrap()
		.parse()
		.unwrap();
	assert_stopped(descendant);
}

#[test]
fn startup_failure_is_reported_without_leaking_children() {
	let (_root, config) = fixture("console.error('broken startup'); process.exit(23);");
	let result = ServerProcess::start(config.clone(), |_| {});
	let error = result.err().expect("startup must fail");
	assert!(error.to_string().contains("23"), "{error}");
	assert!(fs::read_to_string(config.log_dir.join("server.err.log"))
		.unwrap()
		.contains("broken startup"));
}

#[test]
fn refuses_an_occupied_port_without_stopping_its_owner() {
	let (_root, config) = fixture(SERVER);
	let listener = TcpListener::bind(("127.0.0.1", config.port().unwrap())).unwrap();
	let result = ServerProcess::start(config.clone(), |_| {});
	assert!(result.err().unwrap().to_string().contains("already in use"));
	assert_eq!(
		listener.local_addr().unwrap().port(),
		config.port().unwrap()
	);
	assert!(!config.project_root.join("starts").exists());
}

#[test]
fn dropping_the_owner_stops_the_server() {
	let (_root, config) = fixture(SERVER);
	let server = ServerProcess::start(config.clone(), |_| {}).unwrap();
	let address = SocketAddr::from(([127, 0, 0, 1], config.port().unwrap()));
	assert!(healthy(address));
	drop(server);
	assert!(!healthy(address));
}

#[test]
fn reads_installer_json_and_rejects_missing_source() {
	let (root, config) = fixture(SERVER);
	let path = root.path().join("server.json");
	fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
	assert_eq!(ServerConfig::load(&path).unwrap().env, config.env);
	fs::remove_file(config.project_root.join("apps/server/src/index.ts")).unwrap();
	assert!(ServerConfig::load(&path).is_err());
}

#[test]
fn migrates_launch_agent_overrides_once() {
	let (root, config) = fixture(SERVER);
	let legacy = root
		.path()
		.join("Library/LaunchAgents/com.revv.server.plist");
	fs::create_dir_all(legacy.parent().unwrap()).unwrap();
	fs::write(&legacy, serde_json::to_vec(&serde_json::json!({
        "ProgramArguments": [config.executable, "run", "apps/server/src/index.ts"],
        "WorkingDirectory": config.project_root,
        "EnvironmentVariables": { "REVV_DB_PATH": "/custom/data/revv.db", "PORT": "45678", "REVV_CODEX_BIN": "/custom/codex" },
        "StandardOutPath": config.log_dir.join("server.out.log"),
    })).unwrap()).unwrap();
	let migrated = server_config::load_installed(root.path()).unwrap();
	assert_eq!(migrated.env["REVV_DB_PATH"], "/custom/data/revv.db");
	assert_eq!(migrated.env["REVV_CODEX_BIN"], "/custom/codex");
	assert!(!legacy.exists());
	assert_eq!(
		server_config::load_installed(root.path()).unwrap().env,
		migrated.env
	);
}
