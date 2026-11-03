//! Keeps the server checkout on the commit this app was built from.
//!
//! The in-app updater replaces only the `.app`. The server runs from the
//! source checkout `install.sh` cloned, so without this every server-side fix
//! stayed missing until the user ran `revv update` by hand. Before starting
//! the server, the app moves that checkout to its own build commit and
//! reinstalls dependencies, the same steps `revv update` takes.
//!
//! Only the installer-managed checkout is touched, and only when it has no
//! local edits: a checkout elsewhere, or one with changes, is someone's work.
//! Every failure leaves the checkout as it was and the server starts anyway;
//! the app then warns that the service is out of date.

use crate::server_config::ServerConfig;
use std::{
	fs::OpenOptions,
	io::{Read, Write},
	path::Path,
	process::{Command, Stdio},
	thread,
	time::{Duration, Instant},
};

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The checkout `install.sh` manages, relative to the home directory.
pub const MANAGED_CHECKOUT: &str = "Library/Application Support/Revv/src";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
	UpToDate,
	Updated { from: String },
	Skipped(String),
}

/// Bring the managed checkout to `target`, logging the outcome to the server
/// error log. Never fails: the caller starts the server either way.
pub fn sync(config: &ServerConfig, managed_root: &Path, target: &str) -> Outcome {
	let outcome = sync_checkout(config, managed_root, target)
		.unwrap_or_else(|error| Outcome::Skipped(format!("update failed: {error}")));
	let message = match &outcome {
		Outcome::UpToDate => return outcome,
		Outcome::Updated { from } => format!("updated server source {from} -> {target}"),
		Outcome::Skipped(reason) => format!("left server source as is: {reason}"),
	};
	let _ = OpenOptions::new()
		.create(true)
		.append(true)
		.open(config.log_dir.join("server.err.log"))
		.and_then(|mut log| writeln!(log, "[server-source] {message}"));
	outcome
}

fn sync_checkout(config: &ServerConfig, managed_root: &Path, target: &str) -> Result<Outcome, String> {
	if target.len() != 40 || !target.bytes().all(|b| b.is_ascii_hexdigit()) {
		return Ok(Outcome::Skipped("this build has no source commit".into()));
	}
	let root = &config.project_root;
	let managed = matches!(
		(root.canonicalize(), managed_root.canonicalize()),
		(Ok(root), Ok(managed)) if root == managed
	);
	if !managed {
		return Ok(Outcome::Skipped(format!(
			"{} is not the installer-managed checkout",
			root.display()
		)));
	}

	let git = |args: &[&str], timeout| {
		let mut command = Command::new("git");
		command.arg("-C").arg(root).args(args).envs(&config.env);
		run(command, timeout)
	};

	let head = git(&["rev-parse", "HEAD"], GIT_TIMEOUT)?.trim().to_owned();
	if head.eq_ignore_ascii_case(target) {
		return Ok(Outcome::UpToDate);
	}
	// `bun install` rewrites the lockfile's version stamp, so that one change
	// is ours, not the user's.
	let edits = git(&["status", "--porcelain", "--untracked-files=no"], GIT_TIMEOUT)?;
	if edits.lines().any(|line| line.get(3..) != Some("bun.lock")) {
		return Ok(Outcome::Skipped("the checkout has local changes".into()));
	}

	let commit = format!("{target}^{{commit}}");
	if git(&["cat-file", "-e", &commit], GIT_TIMEOUT).is_err() {
		git(&["fetch", "--quiet", "--no-tags", "origin", target], GIT_TIMEOUT)?;
	}
	git(&["reset", "--quiet", "--hard", target], GIT_TIMEOUT)?;

	let mut install = Command::new(&config.executable);
	install.arg("install").current_dir(root).envs(&config.env);
	if let Err(error) = run(install, INSTALL_TIMEOUT) {
		// New source over old dependencies may not even start; go back.
		git(&["reset", "--quiet", "--hard", &head], GIT_TIMEOUT)?;
		return Err(format!("bun install failed, restored {head}: {error}"));
	}
	Ok(Outcome::Updated { from: head })
}

/// Run to completion within `timeout`, returning stdout.
fn run(mut command: Command, timeout: Duration) -> Result<String, String> {
	let mut child = command
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|error| error.to_string())?;
	// Drain both pipes while waiting, so a chatty child can't block on a full pipe.
	let drain = |pipe: Option<Box<dyn Read + Send>>| {
		thread::spawn(move || {
			let mut text = String::new();
			if let Some(mut pipe) = pipe {
				let _ = pipe.read_to_string(&mut text);
			}
			text
		})
	};
	let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
	let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
	let deadline = Instant::now() + timeout;
	let status = loop {
		if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
			break status;
		}
		if Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			return Err(format!("timed out after {}s", timeout.as_secs()));
		}
		thread::sleep(POLL_INTERVAL);
	};
	let stdout = stdout.join().unwrap_or_default();
	let stderr = stderr.join().unwrap_or_default();
	if status.success() {
		Ok(stdout)
	} else {
		Err(format!("{status}: {}", stderr.trim()))
	}
}

#[cfg(test)]
#[path = "server_source_tests.rs"]
mod tests;
