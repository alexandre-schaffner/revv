"""Sign verified build artifacts, assemble the manifest, and publish one draft."""
import argparse
import base64
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

from artifacts import validate_set


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "publish"])
    command = parser.parse_args().command
    tag = os.environ["RELEASE_TAG"]
    version = os.environ["RELEASE_VERSION"]
    sha = os.environ["SOURCE_SHA"]
    nightly = os.environ["NIGHTLY"] == "true"
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+|nightly-[a-f0-9]{7,40}", tag):
        raise ValueError("Invalid release tag")
    directory = pathlib.Path("dist")
    validate_set(directory, version, prepared=command == "publish", nightly=nightly)
    release = json.loads(gh("release", "view", tag, "--json", "isDraft"))
    if not release["isDraft"]:
        raise ValueError("Refusing to alter a published release")
    # Validate the tag independently of artifact metadata.
    actual = subprocess.check_output(["git", "rev-parse", f"refs/tags/{tag}^{{commit}}"], text=True).strip()
    if actual != sha:
        raise ValueError("Release tag does not match the tested source SHA")
    config = json.loads(pathlib.Path("apps/desktop/tauri.conf.json").read_text())
    if command == "publish":
        publish(directory, tag, nightly)
        return
    if not nightly and config["version"] != version:
        raise ValueError("Stable tag differs from the committed application version")
    public_key = base64.b64decode(config["plugins"]["updater"]["pubkey"], validate=True)
    platforms = {}
    with tempfile.TemporaryDirectory() as temp:
        public_path = pathlib.Path(temp) / "updater.pub"
        public_path.write_bytes(public_key)
        for arch, platform in [("aarch64", "darwin-aarch64"), ("x64", "darwin-x86_64")]:
            updater = directory / f"Revv_{arch}.app.tar.gz"
            # Tauri's file signature is base64 of the full minisign signature.
            signature = pathlib.Path(f"{updater}.sig")
            subprocess.run([os.environ["TAURI_SIGNER"], "signer", "sign", "--app-version", version, str(updater)], check=True)
            decoded = pathlib.Path(temp) / f"{arch}.minisig"
            decoded.write_bytes(base64.b64decode(signature.read_text().strip(), validate=True))
            subprocess.run(["minisign", "-Vm", str(updater), "-p", str(public_path), "-x", str(decoded)], check=True)
            platforms[platform] = {
                "signature": signature.read_text().strip(),
                "url": f"https://github.com/{os.environ['GH_REPO']}/releases/download/{tag}/{updater.name}",
            }
    manifest = {"version": version, "notes": os.environ["UPDATER_NOTES"], "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(), "platforms": platforms}
    (directory / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if not nightly:
        subprocess.run(["bash", "scripts/release/build-installer.sh"], check=True)


def publish(directory, tag, nightly):
    # Upload once. A failed upload is fatal and leaves the release as a draft.
    assets = [str(p) for p in sorted(directory.iterdir()) if p.is_file()]
    expected = {pathlib.Path(p).name for p in assets}
    prior = json.loads(gh("release", "view", tag, "--json", "assets"))["assets"]
    for asset in prior:
        if asset["name"] not in expected:
            gh("release", "delete-asset", tag, asset["name"], "--yes")
    gh("release", "upload", tag, *assets, "--clobber")
    uploaded = json.loads(gh("api", f"repos/{os.environ['GH_REPO']}/releases/tags/{tag}"))["assets"]
    by_name = {asset["name"]: asset for asset in uploaded}
    if set(by_name) != expected:
        raise ValueError("Remote draft assets do not exactly match the verified release")
    for file in directory.iterdir():
        digest = "sha256:" + hashlib.sha256(file.read_bytes()).hexdigest()
        if by_name[file.name]["size"] != file.stat().st_size or by_name[file.name].get("digest") != digest:
            raise ValueError(f"Uploaded asset missing or corrupted: {file.name}")
    gh("release", "edit", tag, "--draft=false", f"--prerelease={str(nightly).lower()}", "--latest=false" if nightly else "--latest")
    published = json.loads(gh("api", f"repos/{os.environ['GH_REPO']}/releases/tags/{tag}"))
    if not published.get("immutable"):
        raise ValueError("Release was published mutable; enable immutable releases")


if __name__ == "__main__":
    main()
