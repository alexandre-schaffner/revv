# Revv.app, taken prebuilt from a GitHub release.
#
# Since 0.33.0 the bundle carries the compiled API server
# (Contents/MacOS/revv-server) and the desktop app starts and stops it, so
# this package is the whole install: there is nothing to build from source.
# The release is pinned in release.json.
{
  lib,
  stdenvNoCC,
  fetchurl,
  release,
}:
let
  system = stdenvNoCC.hostPlatform.system;
  asset = release.assets.${system} or (throw "Revv has no prebuilt app for ${system}");
in
stdenvNoCC.mkDerivation {
  pname = "revv-desktop";
  version = release.version;

  src = fetchurl { inherit (asset) url hash; };

  # The tarball is the updater artifact: one `<product name>.app/` at the top.
  sourceRoot = ".";
  dontConfigure = true;
  dontBuild = true;
  # Don't let stdenv strip or patch the signed Mach-O binaries.
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    apps=(*.app)
    if [ "''${#apps[@]}" -ne 1 ] || [ ! -d "''${apps[0]}" ]; then
      echo "expected exactly one .app in the release tarball, found: ''${apps[*]}" >&2
      exit 1
    fi
    # An app without its server can't start: releases before 0.33.0 ran it
    # from a source checkout, which a Nix install doesn't have.
    if [ ! -x "''${apps[0]}/Contents/MacOS/revv-server" ]; then
      echo "''${apps[0]} has no bundled server; pin Revv 0.33.0 or later" >&2
      exit 1
    fi
    mkdir -p "$out/Applications"
    cp -R "''${apps[0]}" "$out/Applications/"
    runHook postInstall
  '';

  meta = {
    description = "AI-powered code review desktop app (prebuilt bundle)";
    homepage = "https://github.com/alexandre-schaffner/revv";
    license = lib.licenses.mit;
    platforms = builtins.attrNames release.assets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
