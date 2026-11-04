{
  description = "Revv: AI-powered code review (Revv.app, Home Manager module, dev shell)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-compat = {
      url = "github:edolstra/flake-compat";
      flake = false;
    };
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;
      # Revv is macOS-only. Releases also ship an Intel app, but the pinned
      # nixpkgs has dropped x86_64-darwin.
      systems = [ "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # The GitHub release Revv.app comes from. The bundle carries the desktop
      # shell, the web frontend and the compiled server, so this one pin is the
      # whole install. CI moves it after every stable release
      # (.github/workflows/nix-release-pin.yml); `nix run .#update-release`
      # does the same by hand.
      release = lib.importJSON ./nix/release.json;

      # The port the desktop app, the updater endpoint and the frontend's CSP
      # all agree on, read from its source of truth instead of copied here.
      apiPort =
        let
          match = builtins.match ".*export const API_PORT = ([0-9]+);.*" (
            builtins.readFile ./packages/shared/src/constants.ts
          );
        in
        if match == null then
          throw "API_PORT not found in packages/shared/src/constants.ts"
        else
          lib.toInt (builtins.head match);
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          revv-app = pkgs.callPackage ./nix/app.nix { inherit release; };
          revv-cli = pkgs.callPackage ./nix/cli.nix {
            app = revv-app;
            inherit apiPort;
          };
        in
        {
          inherit revv-app revv-cli;
          # Revv.app under Applications/ and `revv` under bin/.
          default = pkgs.symlinkJoin {
            name = "revv-${release.version}";
            paths = [
              revv-app
              revv-cli
            ];
          };
        }
      );

      apps = forAllSystems (pkgs: {
        update-release = {
          type = "app";
          program = lib.getExe (
            pkgs.writeShellApplication {
              name = "revv-update-release";
              runtimeInputs = with pkgs; [
                curl
                jq
                coreutils
                unixtools.xxd
              ];
              text = builtins.readFile ./nix/update-release.sh;
            }
          );
        };
      });

      homeManagerModules = rec {
        revv =
          { pkgs, ... }@args:
          (import ./nix/home-manager.nix {
            revvPackages = self.packages.${pkgs.stdenv.hostPlatform.system};
          })
            args;
        default = revv;
      };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # Tools on PATH.
          packages = with pkgs; [
            bun
            cargo
            rustc
            rustfmt
            clippy
            rust-analyzer
            git
            gnumake
            pkg-config
          ];

          # Linked libraries. In buildInputs so apple-sdk's setup hook sets SDKROOT.
          buildInputs = with pkgs; [
            apple-sdk_15
            libiconv
          ];

          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";

          shellHook = ''
            echo "revv dev shell: bun $(bun --version), $(rustc --version)"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
