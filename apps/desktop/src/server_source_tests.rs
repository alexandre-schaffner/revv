use super::*;
use std::{collections::HashMap, fs, os::unix::fs::PermissionsExt, path::PathBuf};

const IDENTITY: [&str; 4] = ["-c", "user.name=Revv Test", "-c", "user.email=revv-test@example.invalid"];

fn git(dir: &Path, args: &[&str]) -> String {
	let output = Command::new("git")
		.args(IDENTITY)
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn commit(repo: &Path, file: &str, contents: &str) -> String {
	fs::write(repo.join(file), contents).unwrap();
	git(repo, &["add", "."]);
	git(repo, &["commit", "--quiet", "-m", contents]);
	git(repo, &["rev-parse", "HEAD"])
}

struct Fixture {
	_root: tempfile::TempDir,
	origin: PathBuf,
	managed: PathBuf,
	config: ServerConfig,
	first: String,
	second: String,
}

/// An origin with two commits, and the managed checkout cloned at the first
/// one. `install_exit` is the exit code of the stand-in `bun install`.
fn fixture(install_exit: i32) -> Fixture {
	let root = tempfile::tempdir().unwrap();
	let origin = root.path().join("origin");
	fs::create_dir_all(&origin).unwrap();
	git(&origin, &["init", "--quiet"]);
	fs::write(origin.join("bun.lock"), "lock v1\n").unwrap();
	let first = commit(&origin, "server.ts", "first");
	let second = commit(&origin, "server.ts", "second");

	let managed = root.path().join("home").join(MANAGED_CHECKOUT);
	fs::create_dir_all(managed.parent().unwrap()).unwrap();
	git(root.path(), &["clone", "--quiet", origin.to_str().unwrap(), managed.to_str().unwrap()]);
	git(&managed, &["checkout", "--quiet", "--detach", &first]);

	let bun = root.path().join("bun");
	fs::write(&bun, format!("#!/bin/sh\necho \"$@\" > installed\nexit {install_exit}\n")).unwrap();
	fs::set_permissions(&bun, fs::Permissions::from_mode(0o755)).unwrap();

	let env = ["PATH", "HOME"]
		.into_iter()
		.filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
		.collect::<HashMap<_, _>>();
	let config = ServerConfig {
		executable: bun,
		project_root: managed.clone(),
		log_dir: root.path().join("logs"),
		env,
	};
	fs::create_dir_all(&config.log_dir).unwrap();
	Fixture { _root: root, origin, managed, config, first, second }
}

fn head(fixture: &Fixture) -> String {
	git(&fixture.managed, &["rev-parse", "HEAD"])
}

fn log(fixture: &Fixture) -> String {
	fs::read_to_string(fixture.config.log_dir.join("server.err.log")).unwrap_or_default()
}

#[test]
fn moves_the_managed_checkout_to_the_build_commit_and_installs() {
	let f = fixture(0);
	assert_eq!(
		sync(&f.config, &f.managed, &f.second),
		Outcome::Updated { from: f.first.clone() }
	);
	assert_eq!(head(&f), f.second);
	assert_eq!(fs::read_to_string(f.managed.join("installed")).unwrap().trim(), "install");
	assert!(log(&f).contains(&format!("updated server source {} -> {}", f.first, f.second)));
}

#[test]
fn fetches_a_build_commit_the_checkout_has_not_seen() {
	let f = fixture(0);
	let third = commit(&f.origin, "server.ts", "third");
	assert!(matches!(sync(&f.config, &f.managed, &third), Outcome::Updated { .. }));
	assert_eq!(head(&f), third);
}

#[test]
fn does_nothing_when_already_on_the_build_commit() {
	let f = fixture(0);
	assert_eq!(sync(&f.config, &f.managed, &f.first), Outcome::UpToDate);
	assert!(!f.managed.join("installed").exists());
	assert_eq!(log(&f), "");
}

#[test]
fn leaves_a_checkout_outside_the_managed_location_alone() {
	let f = fixture(0);
	let elsewhere = f.origin.clone();
	assert!(matches!(sync(&f.config, &elsewhere, &f.second), Outcome::Skipped(_)));
	assert_eq!(head(&f), f.first);
	assert!(log(&f).contains("not the installer-managed checkout"));
}

#[test]
fn leaves_local_edits_alone() {
	let f = fixture(0);
	fs::write(f.managed.join("server.ts"), "my patch").unwrap();
	assert_eq!(
		sync(&f.config, &f.managed, &f.second),
		Outcome::Skipped("the checkout has local changes".into())
	);
	assert_eq!(head(&f), f.first);
	assert_eq!(fs::read_to_string(f.managed.join("server.ts")).unwrap(), "my patch");
}

#[test]
fn treats_a_rewritten_lockfile_as_its_own_change() {
	let f = fixture(0);
	fs::write(f.managed.join("bun.lock"), "lock v2\n").unwrap();
	assert!(matches!(sync(&f.config, &f.managed, &f.second), Outcome::Updated { .. }));
	assert_eq!(head(&f), f.second);
}

#[test]
fn restores_the_checkout_when_install_fails() {
	let f = fixture(1);
	let outcome = sync(&f.config, &f.managed, &f.second);
	assert!(
		matches!(&outcome, Outcome::Skipped(reason) if reason.contains("bun install failed")),
		"{outcome:?}"
	);
	assert_eq!(head(&f), f.first);
}

#[test]
fn skips_a_build_without_a_source_commit() {
	let f = fixture(0);
	assert!(matches!(sync(&f.config, &f.managed, ""), Outcome::Skipped(_)));
	assert_eq!(head(&f), f.first);
}
