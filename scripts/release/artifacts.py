"""Stage and validate macOS bundles without executing their contents."""
import argparse
import hashlib
import json
import pathlib
import plistlib
import struct
import tarfile


ARCHES = {"aarch64": 0x0100000C, "x64": 0x01000007}


def validate_archive(path, version, arch):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        roots = set()
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not name.parts:
                raise ValueError("Unsafe archive path")
            roots.add(name.parts[0])
            if member.isdev() or member.isfifo() or member.islnk():
                raise ValueError("Unsupported archive entry")
            if member.issym():
                target = pathlib.PurePosixPath(member.linkname)
                # Framework symlinks such as Versions/Current are legitimate.
                depth = len(name.parts) - 1
                for part in target.parts:
                    depth += -1 if part == ".." else 1
                    if depth < 1:
                        raise ValueError("Archive symlink escapes app")
                if target.is_absolute():
                    raise ValueError("Absolute archive symlink")
        if len(roots) != 1 or not next(iter(roots)).endswith(".app"):
            raise ValueError("Expected one app in updater archive")
        root = next(iter(roots))
        plist = archive.extractfile(f"{root}/Contents/Info.plist")
        if plist is None:
            raise ValueError("Missing app plist")
        info = plistlib.loads(plist.read())
        if info.get("CFBundleShortVersionString") != version:
            raise ValueError("App version differs from release version")
        executable = info.get("CFBundleExecutable", "")
        if not executable or pathlib.PurePosixPath(executable).name != executable:
            raise ValueError("Invalid app executable name")
        binary = archive.extractfile(f"{root}/Contents/MacOS/{executable}")
        if binary is None:
            raise ValueError("Missing app executable")
        header = binary.read(8)
        if len(header) != 8 or struct.unpack("<II", header) != (0xFEEDFACF, ARCHES[arch]):
            raise ValueError("App architecture differs from matrix target")


def validate_set(directory, version, *, prepared=False, nightly=False):
    files = []
    for arch in ARCHES:
        dmg = directory / f"Revv_{version}_{arch}.dmg"
        updater = directory / f"Revv_{arch}.app.tar.gz"
        for path in (dmg, updater):
            if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
                raise ValueError(f"Missing or empty release asset: {path.name}")
            files.append(path)
        validate_archive(updater, version, arch)
    expected = {p.name for p in files}
    if prepared:
        expected.update({"Revv_aarch64.app.tar.gz.sig", "Revv_x64.app.tar.gz.sig", "latest.json"})
        if not nightly:
            expected.update({"install.sh", "SHA256SUMS", "install.sh.sigstore", "SHA256SUMS.sigstore"})
    actual = {p.name for p in directory.iterdir()}
    if actual != expected:
        raise ValueError(f"Release asset set differs: missing={expected - actual}, extra={actual - expected}")
    for name in expected:
        path = directory / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            raise ValueError(f"Invalid release asset: {name}")
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("version")
    args = parser.parse_args()
    files = validate_set(args.directory, args.version)
    print(json.dumps({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}, indent=2))


if __name__ == "__main__":
    main()
