"""Normalize one Tauri matrix leg into a bounded release artifact."""
import argparse
import pathlib
import tarfile

from artifacts import validate_archive

parser = argparse.ArgumentParser()
parser.add_argument("target")
parser.add_argument("arch", choices=["aarch64", "x64"])
parser.add_argument("version")
args = parser.parse_args()
bundles = pathlib.Path("apps/desktop/target") / args.target / "release/bundle"
apps = list((bundles / "macos").glob("*.app"))
if len(apps) != 1:
    raise ValueError("Expected exactly one app from this matrix leg")
staging = pathlib.Path("dist")
staging.mkdir(exist_ok=True)
updater = staging / f"Revv_{args.arch}.app.tar.gz"
with tarfile.open(updater, "w:gz", dereference=False) as archive:
    archive.add(apps[0], arcname=apps[0].name)
validate_archive(updater, args.version, args.arch)
