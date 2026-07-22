#!/usr/bin/env bash
# Builds signed installer artifacts for a Revv release.
# Runs in CI as part of the package-installer job.
#
# Required env:
#   RELEASE_TAG   — git tag, e.g. "v0.1.0"
#   REVV_VERSION  — version without v prefix, e.g. "0.1.0"
#   GH_TOKEN      — GitHub token with release read/write access
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"

TAG="${RELEASE_TAG}"
VERSION="${REVV_VERSION}"
REPO="alexandre-schaffner/revv"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

# URL-encode a filename (percent-encodes all chars except unreserved)
url_encode() {
  python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}

sha256_of() {
  if [[ -f "$1" ]]; then
    sha256sum "$1" | cut -d' ' -f1
  else
    echo "MISSING"
  fi
}

# Find the first file matching a glob under a directory
find_bundle() {
  local dir="$1" pattern="$2"
  find "$dir" -name "$pattern" -type f 2>/dev/null | sort | head -1
}

# Build a release download URL from an actual local filename
make_url() {
  local file="$1"
  if [[ -z "$file" || ! -f "$file" ]]; then
    echo "MISSING"
    return
  fi
  echo "${BASE_URL}/$(url_encode "$(basename "$file")")"
}

echo "==> Downloading bundles from release $TAG..."
BUNDLE_DIR="$(mktemp -d)"
# Downloads whatever is attached; missing assets produce a warning, not an error
gh release download "$TAG" \
  --pattern '*.dmg' \
  --dir "$BUNDLE_DIR" || true

ls -la "$BUNDLE_DIR/"

# Locate each bundle
DMG_ARM64="$(find_bundle "$BUNDLE_DIR" '*aarch64*.dmg')"
DMG_X64="$(find_bundle "$BUNDLE_DIR" '*x64*.dmg')"
[[ -z "$DMG_X64" ]] && DMG_X64="$(find_bundle "$BUNDLE_DIR" '*x86_64*.dmg')"

SHA_DMG_ARM64="$(sha256_of "$DMG_ARM64")"
SHA_DMG_X64="$(sha256_of "$DMG_X64")"

URL_DMG_ARM64="$(make_url "$DMG_ARM64")"
URL_DMG_X64="$(make_url "$DMG_X64")"

echo ""
echo "Bundle SHAs and URLs:"
echo "  DMG arm64:  $SHA_DMG_ARM64"
echo "              $URL_DMG_ARM64"
echo "  DMG x64:    $SHA_DMG_X64"
echo "              $URL_DMG_X64"

# Substitute template variables into an installer template
substitute() {
  local tmpl="$1" out="$2"
  sed \
    -e "s|@@REVV_VERSION@@|${VERSION}|g" \
    -e "s|@@RELEASE_TAG@@|${TAG}|g" \
    -e "s|@@URL_DMG_ARM64@@|${URL_DMG_ARM64}|g" \
    -e "s|@@URL_DMG_X64@@|${URL_DMG_X64}|g" \
    -e "s|@@SHA_DMG_ARM64@@|${SHA_DMG_ARM64}|g" \
    -e "s|@@SHA_DMG_X64@@|${SHA_DMG_X64}|g" \
    "$tmpl" > "$out"
  chmod +x "$out"
}

echo ""
echo "==> Substituting templates..."
substitute "$SCRIPT_DIR/install.sh.tmpl"  "$DIST_DIR/install.sh"
{
  printf '\n# ---- embedded canonical installer ----\n'
  sed '1{/^#!/d;}' "$REPO_ROOT/install.sh"
} >> "$DIST_DIR/install.sh"
chmod +x "$DIST_DIR/install.sh"

# SHA256SUMS covers the installer script and all downloaded bundles
echo ""
echo "==> Generating SHA256SUMS..."
(cd "$DIST_DIR" && sha256sum install.sh) > "$DIST_DIR/SHA256SUMS"
for f in "$BUNDLE_DIR"/*; do
  [[ -f "$f" ]] && sha256sum "$f" | sed "s|${BUNDLE_DIR}/||g" >> "$DIST_DIR/SHA256SUMS"
done

rm -rf "$BUNDLE_DIR"

echo ""
echo "==> Generated artifacts:"
ls -lh "$DIST_DIR/"
