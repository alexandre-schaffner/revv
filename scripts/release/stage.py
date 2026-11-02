"""Normalize one Tauri matrix leg into a bounded release artifact."""
import argparse
import pathlib
import hashlib
import shutil
import subprocess
import tempfile
import tarfile

from artifacts import validate_archive

parser = argparse.ArgumentParser()
parser.add_argument("target")
parser.add_argument("arch", choices=["aarch64", "x64"])
parser.add_argument("version")
args = parser.parse_args()
bundles = pathlib.Path("apps/desktop/target") / args.target / "release/bundle"
apps = list((bundles / "macos").glob("*.app"))
dmgs = list((bundles / "dmg").glob("*.dmg"))
if len(apps) != 1 or len(dmgs) != 1:
    raise ValueError("Expected exactly one app and one DMG from this matrix leg")
# Verify the disk image contains the same app as the updater, without launching it.
subprocess.run(["hdiutil", "verify", str(dmgs[0])], check=True)
with tempfile.TemporaryDirectory() as mount:
    subprocess.run(["hdiutil", "attach", str(dmgs[0]), "-readonly", "-nobrowse", "-mountpoint", mount], check=True, stdout=subprocess.DEVNULL)
    try:
        installed = pathlib.Path(mount) / apps[0].name
        for relative in ["Contents/Info.plist", "Contents/MacOS/revv-desktop"]:
            if hashlib.sha256((installed / relative).read_bytes()).digest() != hashlib.sha256((apps[0] / relative).read_bytes()).digest():
                raise ValueError("DMG app differs from updater app")
    finally:
        subprocess.run(["hdiutil", "detach", mount], check=True)
staging = pathlib.Path("dist")
staging.mkdir(exist_ok=True)
updater = staging / f"Revv_{args.arch}.app.tar.gz"
with tarfile.open(updater, "w:gz", dereference=False) as archive:
    archive.add(apps[0], arcname=apps[0].name)
validate_archive(updater, args.version, args.arch)
shutil.copyfile(dmgs[0], staging / f"Revv_{args.version}_{args.arch}.dmg")
