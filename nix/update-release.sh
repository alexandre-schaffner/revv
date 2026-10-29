# Moves nix/release.json to a GitHub release: the latest stable one, or the
# tag given as the first argument (a `nightly-<sha>` tag works too).
#
#   nix run .#update-release            # latest stable
#   nix run .#update-release v0.33.0
#
# Asset hashes come from the release API's sha256 digests; when a release
# predates digests, the asset is downloaded and hashed.
repo="alexandre-schaffner/revv"
out="${REVV_ROOT:-$PWD}/nix/release.json"
[ -f "$out" ] || { echo "run from the repository root ($out not found)" >&2; exit 1; }

api="https://api.github.com/repos/$repo/releases"
if [ -n "${1:-}" ]; then
  release="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api/tags/$1")"
else
  release="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api/latest")"
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
  local url digest hex tmp
  url="$(jq -r --arg s "$2" '[.assets[] | select(.name | endswith($s))][0].browser_download_url // empty' <<<"$release")"
  [ -n "$url" ] || { echo "release $tag has no *$2 asset" >&2; exit 1; }
  digest="$(jq -r --arg s "$2" '[.assets[] | select(.name | endswith($s))][0].digest // empty' <<<"$release")"
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

jq -n \
  --arg tag "$tag" \
  --arg version "$version" \
  --argjson arm "$(asset_json aarch64-darwin _aarch64.app.tar.gz)" \
  --argjson intel "$(asset_json x86_64-darwin _x64.app.tar.gz)" \
  '{tag: $tag, version: $version, assets: ($arm + $intel)}' > "$out"

echo "pinned $tag ($version) in $out"
