fn main() {
    println!("cargo:rerun-if-changed=server-launcher");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_server_launcher();
    }
    tauri_build::build();
}

fn build_server_launcher() {
    use std::{fs, path::Path, process::Command};

    let contents = Path::new("target/server-launcher/Revv.app/Contents");
    fs::create_dir_all(contents.join("MacOS")).expect("create server launcher directory");
    fs::create_dir_all(contents.join("Resources")).expect("create server icon directory");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").expect("target architecture");
    let arch = if arch == "aarch64" { "arm64" } else { &arch };
    let status = Command::new("xcrun")
        .args([
            "clang",
            "-fobjc-arc",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-framework",
            "AppKit",
            "-target",
        ])
        .arg(format!("{arch}-apple-macos10.15"))
        .arg("server-launcher/main.m")
        .arg("-o")
        .arg(contents.join("MacOS/revv-server"))
        .status()
        .expect("compile Revv server launcher with Xcode command line tools");
    assert!(status.success(), "could not compile Revv server launcher");
    let plist =
        fs::read_to_string("server-launcher/Info.plist").expect("read server launcher plist");
    fs::write(
        contents.join("Info.plist"),
        plist.replace("@VERSION@", env!("CARGO_PKG_VERSION")),
    )
    .expect("write server launcher plist");
    fs::copy("icons/icon.icns", contents.join("Resources/icon.icns"))
        .expect("copy Revv server icon");
    let status = Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(contents.parent().expect("server app directory"))
        .status()
        .expect("sign Revv server helper bundle");
    assert!(status.success(), "could not sign Revv server helper bundle");
}
