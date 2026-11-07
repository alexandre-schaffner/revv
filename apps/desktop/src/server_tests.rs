use super::*;
use crate::server_config;
use std::{collections::HashMap, net::TcpListener, path::PathBuf};

fn fixture(script: &str) -> (tempfile::TempDir, ServerCommand, ServerConfig) {
	let root = tempfile::tempdir().unwrap();
	let workdir = root.path().join("server & workspace");
	fs::create_dir_all(&workdir).unwrap();
	let entrypoint = workdir.join("server.ts");
	fs::write(&entrypoint, script).unwrap();
	let bun = Command::new("which").arg("bun").output().unwrap();
	assert!(bun.status.success(), "bun must be on PATH");
	let listener = TcpListener::bind("127.0.0.1:0").unwrap();
	let port = listener.local_addr().unwrap().port();
	let command = ServerCommand {
		program: PathBuf::from(String::from_utf8(bun.stdout).unwrap().trim()),
		args: vec![entrypoint.to_string_lossy().into_owned()],
		cwd: workdir,
	};
	let config = ServerConfig {
		executable: None,
		project_root: None,
		log_dir: root.path().join("logs"),
		env: HashMap::from([
			("PORT".into(), port.to_string()),
			("MARKER".into(), "inherited".into()),
		]),
	};
	(root, command, config)
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
	let (_root, command, config) = fixture(SERVER);
	let server = ServerProcess::start(command.clone(), config.clone(), |message| panic!("{message}")).unwrap();
	let log = fs::read_to_string(config.log_dir.join("server.out.log")).unwrap();
	let state: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
	assert_eq!(state["parent"], std::process::id());
	assert_eq!(state["owner"], std::process::id().to_string());
	assert_eq!(state["marker"], "inherited");
	assert_eq!(
		PathBuf::from(state["cwd"].as_str().unwrap())
			.canonicalize()
			.unwrap(),
		command.cwd.canonicalize().unwrap()
	);
	let descendant: u32 = fs::read_to_string(command.cwd.join("descendant"))
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
	let (_root, command, mut config) = fixture(SERVER);
	config.env.insert("CRASH".into(), "1".into());
	let (failed, result) = mpsc::channel();
	let server = ServerProcess::start(command.clone(), config.clone(), move |message| {
		failed.send(message).unwrap();
	})
	.unwrap();
	let message = result.recv_timeout(Duration::from_secs(15)).unwrap();
	assert!(message.contains("3 restart attempts"), "{message}");
	assert_eq!(
		fs::read_to_string(command.cwd.join("starts"))
			.unwrap()
			.lines()
			.count(),
		4
	);
	server.stop();
	let descendant = fs::read_to_string(command.cwd.join("descendant"))
		.unwrap()
		.parse()
		.unwrap();
	assert_stopped(descendant);
}

fn restart_fixture(fail_all_restarts: bool) -> (tempfile::TempDir, ServerCommand, ServerConfig) {
	fixture(&format!(
		r#"
const fs = require('node:fs');
const attempt = fs.existsSync('starts') ? fs.readFileSync('starts', 'utf8').trim().split('\n').length : 0;
fs.appendFileSync('starts', 'start\n');
if (attempt === 1 || ({fail_all_restarts} && attempt > 0)) process.exit(1);
const app = Bun.serve({{port: Number(process.env.PORT), hostname:'127.0.0.1', fetch:()=>new Response('ok')}});
process.on('SIGTERM', () => {{ app.stop(true); process.exit(0); }});
if (attempt === 0) setTimeout(() => process.exit(1), 300);
"#
	))
}

#[test]
fn retries_a_failed_restart_and_recovers() {
	let (_root, command, config) = restart_fixture(false);
	let (failed, result) = mpsc::channel();
	let server = ServerProcess::start(command.clone(), config.clone(), move |message| {
		failed.send(message).unwrap();
	})
	.unwrap();
	let address = SocketAddr::from(([127, 0, 0, 1], config.port().unwrap()));
	let deadline = Instant::now() + Duration::from_secs(10);
	loop {
		let starts = fs::read_to_string(command.cwd.join("starts")).unwrap();
		if starts.lines().count() == 3 && healthy(address) {
			break;
		}
		assert!(
			Instant::now() < deadline,
			"server did not recover after failed restart"
		);
		thread::sleep(POLL_INTERVAL);
	}
	assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
	server.stop();
	assert!(!healthy(address));
}

#[test]
fn failed_restarts_exhaust_the_budget_before_reporting_failure() {
	let (_root, command, config) = restart_fixture(true);
	let (failed, result) = mpsc::channel();
	let server = ServerProcess::start(command.clone(), config.clone(), move |message| {
		failed.send(message).unwrap();
	})
	.unwrap();
	let message = result.recv_timeout(Duration::from_secs(15)).unwrap();
	assert!(message.contains("3 restart attempts"), "{message}");
	assert_eq!(
		fs::read_to_string(command.cwd.join("starts"))
			.unwrap()
			.lines()
			.count(),
		4
	);
	server.stop();
	assert!(result.try_recv().is_err());
}

#[test]
fn startup_failure_is_reported_without_leaking_children() {
	let (_root, command, config) = fixture("console.error('broken startup'); process.exit(23);");
	let result = ServerProcess::start(command.clone(), config.clone(), |_| {});
	let error = result.err().expect("startup must fail");
	assert!(error.to_string().contains("23"), "{error}");
	assert!(fs::read_to_string(config.log_dir.join("server.err.log"))
		.unwrap()
		.contains("broken startup"));
}

#[test]
fn refuses_an_occupied_port_without_stopping_its_owner() {
	let (_root, command, mut config) = fixture(SERVER);
	// Occupy a port we hold from the moment it's picked. Re-binding the
	// fixture's port raced the other tests: the fixture releases it, and a
	// server started in parallel could take it first ("Address already in use").
	let listener = TcpListener::bind("127.0.0.1:0").unwrap();
	config.env.insert(
		"PORT".into(),
		listener.local_addr().unwrap().port().to_string(),
	);
	let result = ServerProcess::start(command.clone(), config.clone(), |_| {});
	assert!(result.err().unwrap().to_string().contains("already in use"));
	assert_eq!(
		listener.local_addr().unwrap().port(),
		config.port().unwrap()
	);
	assert!(!command.cwd.join("starts").exists());
}

#[test]
fn dropping_the_owner_stops_the_server() {
	let (_root, command, config) = fixture(SERVER);
	let server = ServerProcess::start(command.clone(), config.clone(), |_| {}).unwrap();
	let address = SocketAddr::from(([127, 0, 0, 1], config.port().unwrap()));
	assert!(healthy(address));
	drop(server);
	assert!(!healthy(address));
}

#[test]
fn reads_installer_json_from_older_apps_and_keeps_their_fields() {
	let root = tempfile::tempdir().unwrap();
	let path = root.path().join("server.json");
	let written = serde_json::json!({
		"executable": "/opt/bun",
		"projectRoot": "/gone/source",
		"logDir": root.path().join("logs"),
		"env": { "PORT": "45678", "REVV_DB_PATH": "/custom/revv.db" },
	});
	fs::write(&path, serde_json::to_vec(&written).unwrap()).unwrap();
	// The source checkout no longer has to exist: the server ships in the app.
	let config = ServerConfig::load(&path).unwrap();
	assert_eq!(config.env["REVV_DB_PATH"], "/custom/revv.db");
	assert_eq!(serde_json::to_value(&config).unwrap(), written);
}

#[test]
fn rejects_a_relative_log_directory() {
	let root = tempfile::tempdir().unwrap();
	let path = root.path().join("server.json");
	fs::write(&path, br#"{"logDir":"logs","env":{}}"#).unwrap();
	assert!(ServerConfig::load(&path).is_err());
}

#[test]
fn runs_the_server_bundled_beside_the_app() {
	let (root, _command, mut config) = fixture(SERVER);
	let macos = root.path().join("Revv.app/Contents/MacOS");
	fs::create_dir_all(&macos).unwrap();
	let missing = ServerCommand::bundled(&macos, &config, root.path()).unwrap_err();
	assert!(missing.to_string().contains("Reinstall Revv"), "{missing}");

	fs::write(macos.join("revv-server"), "").unwrap();
	let command = ServerCommand::bundled(&macos, &config, root.path()).unwrap();
	assert_eq!(command.program, macos.join("revv-server"));
	assert!(command.args.is_empty());
	assert_eq!(command.cwd, root.path());

	// Pre-0.15.1 installs kept revv.db in the checkout the server ran from.
	let checkout = root.path().join("checkout");
	fs::create_dir_all(&checkout).unwrap();
	config.project_root = Some(checkout.clone());
	let command = ServerCommand::bundled(&macos, &config, root.path()).unwrap();
	assert_eq!(command.cwd, checkout);
}

#[test]
fn migrates_launch_agent_overrides_once() {
	let root = tempfile::tempdir().unwrap();
	let checkout = root.path().join("source");
	let logs = root.path().join("Library/Logs/Revv");
	let legacy = root
		.path()
		.join("Library/LaunchAgents/com.revv.server.plist");
	fs::create_dir_all(legacy.parent().unwrap()).unwrap();
	fs::write(&legacy, serde_json::to_vec(&serde_json::json!({
        "ProgramArguments": ["/opt/bun", "run", "apps/server/src/index.ts"],
        "WorkingDirectory": checkout,
        "EnvironmentVariables": { "REVV_DB_PATH": "/custom/data/revv.db", "PORT": "45678", "REVV_CODEX_BIN": "/custom/codex" },
        "StandardOutPath": logs.join("server.out.log"),
    })).unwrap()).unwrap();
	let migrated = server_config::load_installed(root.path()).unwrap();
	assert_eq!(migrated.env["REVV_DB_PATH"], "/custom/data/revv.db");
	assert_eq!(migrated.env["REVV_CODEX_BIN"], "/custom/codex");
	assert_eq!(migrated.project_root, Some(checkout));
	assert_eq!(migrated.log_dir, logs);
	assert!(!legacy.exists());
	assert_eq!(
		server_config::load_installed(root.path()).unwrap().env,
		migrated.env
	);
}
