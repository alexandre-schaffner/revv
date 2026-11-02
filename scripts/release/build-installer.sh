#!/usr/bin/env bash
# Package only complete, validated release assets. BUNDLE_DIR may supply local CI artifacts.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
VERSION="${RELEASE_VERSION:-${REVV_VERSION:?REVV_VERSION is required}}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$TAG" == "v${VERSION}" ]] || {
  echo 'Release tag and version must match' >&2; exit 1;
}
mkdir -p "$DIST_DIR"
if [[ -z "${BUNDLE_DIR:-}" ]]; then
  BUNDLE_DIR=$(mktemp -d)
  trap 'rm -rf "$BUNDLE_DIR"' EXIT
  gh release download "$TAG" --pattern "Revv_${VERSION}_aarch64.dmg" --pattern "Revv_${VERSION}_x64.dmg" --dir "$BUNDLE_DIR"
fi
python3 - "$REPO_ROOT" "$BUNDLE_DIR" "$VERSION" "$TAG" <<'PY'
import hashlib
import pathlib
import sys

root, bundles = map(pathlib.Path, sys.argv[1:3])
version, tag = sys.argv[3:5]
files = [bundles / f"Revv_{version}_{arch}.dmg" for arch in ["aarch64", "x64"]]
for file in files:
    if not file.is_file() or file.is_symlink() or file.stat().st_size == 0:
        raise ValueError(f"Missing required DMG: {file.name}")
template = (root / "scripts/release/install.sh.tmpl").read_text()
installer = template.replace("@@REVV_VERSION@@", version).replace("@@RELEASE_TAG@@", tag)
installer += "\n# ---- embedded canonical installer ----\n" + "\n".join((root / "install.sh").read_text().splitlines()[1:]) + "\n"
destination = root / "dist/install.sh"
destination.write_text(installer)
destination.chmod(0o755)
files.insert(0, destination)
files.extend(sorted(bundles.glob("*.app.tar.gz")))
(root / "dist/SHA256SUMS").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files))
PY
