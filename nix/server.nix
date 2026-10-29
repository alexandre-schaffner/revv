# The Revv API server: the TypeScript sources plus their node_modules, run
# from the Nix store by bun, exactly as install.sh's LaunchAgent runs them
# from a source checkout (`bun run apps/server/src/index.ts`).
{
  lib,
  stdenvNoCC,
  makeWrapper,
  bun,
  git,
  openssh,
  src,
  nodeModules,
  version,
}:
stdenvNoCC.mkDerivation {
  pname = "revv-server";
  inherit version src;

  nativeBuildInputs = [ makeWrapper ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    tree="$out/lib/revv"
    mkdir -p "$tree" "$out/bin"
    cp -R . "$tree"
    # Lay the node_modules trees over the sources; their symlinks are
    # relative, so the layout has to be the same as in a checkout.
    cp -a ${nodeModules}/. "$tree/"

    # bun is on PATH too: the server spawns `bunx` for ACP agents, and
    # external integrations run the MCP bridge with `process.execPath`.
    makeWrapper ${bun}/bin/bun "$out/bin/revv-server" \
      --chdir "$tree" \
      --add-flags "run apps/server/src/index.ts" \
      --prefix PATH : ${
        lib.makeBinPath [
          bun
          git
          openssh
        ]
      }
    runHook postInstall
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "Revv API server (Bun + Elysia)";
    homepage = "https://github.com/alexandre-schaffner/revv";
    mainProgram = "revv-server";
    platforms = lib.platforms.darwin;
  };
}
