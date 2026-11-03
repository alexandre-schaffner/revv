use std::{path::Path, process::Command};

fn git(args: &[&str]) -> Option<String> {
	let output = Command::new("git").args(args).output().ok()?;
	if !output.status.success() {
		return None;
	}
	let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
	(!value.is_empty()).then_some(value)
}

/// Embeds the commit this app was built from as `REVV_SOURCE_SHA`, so the app
/// can bring the server checkout to the same commit (see `source_sync.rs`).
/// `REVV_BUILD_SHA` wins, matching how the web build stamps its commit.
fn embed_source_sha() {
	println!("cargo:rerun-if-env-changed=REVV_BUILD_SHA");
	for path in ["HEAD", "packed-refs"]
		.into_iter()
		.filter_map(|name| git(&["rev-parse", "--git-path", name]))
		.chain(
			git(&["symbolic-ref", "-q", "HEAD"])
				.and_then(|branch| git(&["rev-parse", "--git-path", &branch])),
		)
	{
		// A missing path would make Cargo rerun this script on every build.
		if Path::new(&path).exists() {
			println!("cargo:rerun-if-changed={path}");
		}
	}
	let sha = std::env::var("REVV_BUILD_SHA")
		.ok()
		.filter(|sha| !sha.trim().is_empty())
		.or_else(|| git(&["rev-parse", "HEAD"]))
		.unwrap_or_default();
	println!("cargo:rustc-env=REVV_SOURCE_SHA={}", sha.trim());
}

fn main() {
	embed_source_sha();
	tauri_build::build();
}
