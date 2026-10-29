use serde::{Deserialize, Serialize};
use std::{
	collections::HashMap,
	fs, io,
	path::{Path, PathBuf},
	process::Command,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
	pub executable: PathBuf,
	pub project_root: PathBuf,
	pub log_dir: PathBuf,
	pub env: HashMap<String, String>,
}

impl ServerConfig {
	pub fn port(&self) -> io::Result<u16> {
		self.env
			.get("PORT")
			.map(String::as_str)
			.unwrap_or("45678")
			.parse()
			.map_err(|_| io::Error::other("Invalid server PORT"))
	}

	pub fn load(path: &Path) -> io::Result<Self> {
		let config: Self = serde_json::from_slice(&fs::read(path)?)?;
		config.validate()?;
		Ok(config)
	}

	pub fn validate(&self) -> io::Result<()> {
		if !self.executable.is_absolute() || !self.executable.is_file() {
			return Err(io::Error::other(
				"Bun executable is missing. Run the Revv installer again.",
			));
		}
		if !self.project_root.is_absolute()
			|| !self.project_root.join("apps/server/src/index.ts").is_file()
		{
			return Err(io::Error::other(
				"Revv source directory is missing. Run the Revv installer again.",
			));
		}
		if !self.log_dir.is_absolute() || self.port()? == 0 {
			return Err(io::Error::other("Invalid Revv server configuration"));
		}
		Ok(())
	}
}

/// Preserve installed environment overrides when an in-app update replaces only the .app.
pub fn load_installed(home: &Path) -> io::Result<ServerConfig> {
	let path = home.join("Library/Application Support/Revv/desktop-server.json");
	let legacy_path = home.join("Library/LaunchAgents/com.revv.server.plist");
	let config = if path.exists() {
		ServerConfig::load(&path)?
	} else {
		#[derive(Deserialize)]
		#[serde(rename_all = "PascalCase")]
		struct LegacyAgent {
			program_arguments: Vec<String>,
			working_directory: PathBuf,
			environment_variables: HashMap<String, String>,
			standard_out_path: PathBuf,
		}
		let output = Command::new("/usr/bin/plutil")
			.args(["-convert", "json", "-o", "-"])
			.arg(&legacy_path)
			.output()?;
		if !output.status.success() {
			return Err(io::Error::other(
				"Server configuration is missing. Run the Revv installer again.",
			));
		}
		let legacy: LegacyAgent = serde_json::from_slice(&output.stdout)?;
		let executable = legacy
			.program_arguments
			.first()
			.ok_or_else(|| io::Error::other("Legacy server command is missing"))?;
		let config = ServerConfig {
			executable: executable.into(),
			project_root: legacy.working_directory,
			log_dir: legacy
				.standard_out_path
				.parent()
				.ok_or_else(|| io::Error::other("Legacy server log path is invalid"))?
				.into(),
			env: legacy.environment_variables,
		};
		config.validate()?;
		use std::io::Write;
		use std::os::unix::fs::OpenOptionsExt;
		fs::create_dir_all(path.parent().expect("config directory"))?;
		let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
		let mut file = fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o600)
			.open(&temporary)?;
		file.write_all(&serde_json::to_vec_pretty(&config)?)?;
		fs::rename(temporary, &path)?;
		config
	};

	if legacy_path.exists() {
		// Disable before removal so launchd cannot restart Bun behind Tauri.
		let _ = Command::new("/bin/launchctl")
			.args(["unload", "-w"])
			.arg(&legacy_path)
			.output()?;
		fs::remove_file(legacy_path)?;
	}
	Ok(config)
}
