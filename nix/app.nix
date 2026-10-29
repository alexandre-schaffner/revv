# Revv.app, the Tauri desktop shell, taken prebuilt from a GitHub release.
#
# This is what install.sh does too: it never builds the desktop app on the
# user's machine, it downloads the bundle CI built. The release is pinned in
# release.json; `nix run .#update-release` moves the pin.
{
  lib,
  stdenvNoCC,
  fetchurl,
  release,
  system,
}:
let
  asset = release.assets.${system} or (throw "Revv has no prebuilt app for ${system}");
in
stdenvNoCC.mkDerivation {
  pname = "revv-desktop";
  version = release.version;

  src = fetchurl { inherit (asset) url hash; };

  # The tarball is the updater artifact: `Revv (Alpha).app/` at the top level.
  sourceRoot = ".";
  dontConfigure = true;
  dontBuild = true;
  # Don't let stdenv strip or patch the ad-hoc signed Mach-O binary.
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/Applications"
    cp -R *.app "$out/Applications/"
    runHook postInstall
  '';

  meta = {
    description = "AI-powered code review desktop app (prebuilt bundle)";
    homepage = "https://github.com/alexandre-schaffner/revv";
    platforms = [
      "aarch64-darwin"
      "x86_64-darwin"
    ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
