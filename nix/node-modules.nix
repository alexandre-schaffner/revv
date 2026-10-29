# The workspace's node_modules trees, as a fixed-output derivation.
#
# `bun install` needs the network, so it runs in a derivation whose output
# hash is pinned (`hashes` below, one per platform because bun only installs
# the optional native packages of the platform it runs on). When bun.lock
# changes, rebuild with the matching hash set to `lib.fakeHash` and copy the
# hash Nix reports into flake.nix.
#
# Lifecycle scripts are skipped: the root `prepare` script clones a git repo
# for the Effect language service, which is dev tooling, and nothing else in
# the lockfile needs a postinstall.
{
  lib,
  stdenvNoCC,
  bun,
  cacert,
  src,
  hash,
}:
stdenvNoCC.mkDerivation {
  name = "revv-node-modules";
  inherit src;

  nativeBuildInputs = [
    bun
    cacert
  ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
    bun install --frozen-lockfile --production --ignore-scripts --no-progress --no-summary
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    for dir in node_modules apps/*/node_modules packages/*/node_modules; do
      [ -d "$dir" ] || continue
      mkdir -p "$out/$(dirname "$dir")"
      cp -a "$dir" "$out/$dir"
    done
    runHook postInstall
  '';

  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = hash;
}
