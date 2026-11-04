#!/usr/bin/env bash
# Moves nix/release.json to a GitHub release: the latest stable one, or the
# tag given as the first argument (a `nightly-<sha>` tag works too).
#
#   nix run .#update-release            # latest stable
#   nix run .#update-release v0.33.0
#   bash nix/update-release.sh v0.33.0  # without Nix (CI): needs curl, jq, xxd
#
# Asset hashes come from the release API's sha256 digests; when a release
# predates digests, the asset is downloaded and hashed.
set -euo pipefail

repo="alexandre-schaffner/revv"
out="${REVV_ROOT:-$PWD}/nix/release.json"
[ -f "$out" ] || { echo "run from the repository root ($out not found)" >&2; exit 1; }

# <Nix system>:<suffix of its updater tarball>, for the systems flake.nix builds.
pins="aarch64-darwin:_aarch64.app.tar.gz"

api="https://api.github.com/repos/$repo/releases"
auth=()
[ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GH_TOKEN")
gh_api() { curl -fsSL -H 'Accept: application/vnd.github+json' ${auth[@]+"${auth[@]}"} "$1"; }
if [ -n "${1:-}" ]; then
  release="$(gh_api "$api/tags/$1")"
else
  release="$(gh_api "$api/latest")"
fi
tag="$(jq -r '.tag_name' <<<"$release")"

# The version the bundle reports (nightlies are stamped `x.y.z-nightly.N`).
manifest_url="$(jq -r '.assets[] | select(.name == "latest.json") | .browser_download_url' <<<"$release")"
if [ -n "$manifest_url" ]; then
  version="$(curl -fsSL "$manifest_url" | jq -r '.version')"
else
  version="${tag#v}"
fi

sri() { printf 'sha256-%s' "$(printf '%s' "$1" | xxd -r -p | base64)"; }

asset_json() { # <system> <asset name suffix>
  local asset url digest hex tmp
  asset="$(jq -c --arg s "$2" '[.assets[] | select(.name | endswith($s))][0] // empty' <<<"$release")"
  [ -n "$asset" ] || { echo "release $tag has no *$2 asset" >&2; return 1; }
  url="$(jq -r '.browser_download_url' <<<"$asset")"
  digest="$(jq -r '.digest // empty' <<<"$asset")"
  if [ -n "$digest" ]; then
    hex="${digest#sha256:}"
  else
    tmp="$(mktemp)"
    curl -fsSL -o "$tmp" "$url"
    hex="$(sha256sum "$tmp" | cut -d' ' -f1)"
    rm -f "$tmp"
  fi
  jq -n --arg system "$1" --arg url "$url" --arg hash "$(sri "$hex")" '{($system): {url: $url, hash: $hash}}'
}

assets='{}'
for pin in $pins; do
  entry="$(asset_json "${pin%%:*}" "${pin#*:}")"
  assets="$(jq -n --argjson a "$assets" --argjson e "$entry" '$a + $e')"
done

jq -n --arg tag "$tag" --arg version "$version" --argjson assets "$assets" \
  '{tag: $tag, version: $version, assets: $assets}' >"$out"

echo "pinned $tag ($version) in $out"
