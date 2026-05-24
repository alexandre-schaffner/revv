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
  --pattern '*.msi' \
  --pattern '*.deb' \
  --pattern '*.AppImage' \
  --dir "$BUNDLE_DIR" || true

ls -la "$BUNDLE_DIR/"

# Locate each bundle
DMG_ARM64="$(find_bundle "$BUNDLE_DIR" '*aarch64*.dmg')"
DMG_X64="$(find_bundle "$BUNDLE_DIR" '*x64*.dmg')"
[[ -z "$DMG_X64" ]] && DMG_X64="$(find_bundle "$BUNDLE_DIR" '*x86_64*.dmg')"
DEB="$(find_bundle "$BUNDLE_DIR" '*.deb')"
APPIMAGE="$(find_bundle "$BUNDLE_DIR" '*.AppImage')"
MSI="$(find_bundle "$BUNDLE_DIR" '*.msi')"

SHA_DMG_ARM64="$(sha256_of "$DMG_ARM64")"
SHA_DMG_X64="$(sha256_of "$DMG_X64")"
SHA_DEB="$(sha256_of "$DEB")"
SHA_APPIMAGE="$(sha256_of "$APPIMAGE")"
SHA_MSI="$(sha256_of "$MSI")"

URL_DMG_ARM64="$(make_url "$DMG_ARM64")"
URL_DMG_X64="$(make_url "$DMG_X64")"
URL_DEB="$(make_url "$DEB")"
URL_APPIMAGE="$(make_url "$APPIMAGE")"
URL_MSI="$(make_url "$MSI")"

echo ""
echo "Bundle SHAs and URLs:"
echo "  DMG arm64:  $SHA_DMG_ARM64"
echo "              $URL_DMG_ARM64"
echo "  DMG x64:    $SHA_DMG_X64"
echo "              $URL_DMG_X64"
echo "  DEB:        $SHA_DEB"
echo "              $URL_DEB"
echo "  AppImage:   $SHA_APPIMAGE"
echo "              $URL_APPIMAGE"
echo "  MSI:        $SHA_MSI"
echo "              $URL_MSI"

# Substitute template variables into an installer template
substitute() {
  local tmpl="$1" out="$2"
  sed \
    -e "s|@@REVV_VERSION@@|${VERSION}|g" \
    -e "s|@@RELEASE_TAG@@|${TAG}|g" \
    -e "s|@@URL_DMG_ARM64@@|${URL_DMG_ARM64}|g" \
    -e "s|@@URL_DMG_X64@@|${URL_DMG_X64}|g" \
    -e "s|@@URL_DEB@@|${URL_DEB}|g" \
    -e "s|@@URL_APPIMAGE@@|${URL_APPIMAGE}|g" \
    -e "s|@@URL_MSI@@|${URL_MSI}|g" \
    -e "s|@@SHA_DMG_ARM64@@|${SHA_DMG_ARM64}|g" \
    -e "s|@@SHA_DMG_X64@@|${SHA_DMG_X64}|g" \
    -e "s|@@SHA_DEB@@|${SHA_DEB}|g" \
    -e "s|@@SHA_APPIMAGE@@|${SHA_APPIMAGE}|g" \
    -e "s|@@SHA_MSI@@|${SHA_MSI}|g" \
    "$tmpl" > "$out"
  chmod +x "$out"
}

echo ""
echo "==> Substituting templates..."
substitute "$SCRIPT_DIR/install.sh.tmpl"  "$DIST_DIR/install.sh"
substitute "$SCRIPT_DIR/install.ps1.tmpl" "$DIST_DIR/install.ps1"

# SHA256SUMS covers the installer scripts and all downloaded bundles
echo ""
echo "==> Generating SHA256SUMS..."
(cd "$DIST_DIR" && sha256sum install.sh install.ps1) > "$DIST_DIR/SHA256SUMS"
for f in "$BUNDLE_DIR"/*; do
  [[ -f "$f" ]] && sha256sum "$f" | sed "s|${BUNDLE_DIR}/||g" >> "$DIST_DIR/SHA256SUMS"
done

rm -rf "$BUNDLE_DIR"

echo ""
echo "==> Generated artifacts:"
ls -lh "$DIST_DIR/"
