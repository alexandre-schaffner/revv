{
  description = "Revv: AI-powered code review (packages, Home Manager module, dev shell)";

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
      # Revv is macOS-only, and the pinned nixpkgs has dropped x86_64-darwin.
      systems = [ "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Which GitHub release the prebuilt Revv.app comes from. The app bundle
      # carries the web frontend, and the server is built from this tree, so
      # the two must be the same release: a frontend talking to an older
      # server stalls on routes the server doesn't have.
      release = lib.importJSON ./nix/release.json;
      version = (lib.importJSON ./apps/server/package.json).version;
      releaseMatchesSources =
        lib.assertMsg (release.version == version)
          "nix/release.json pins Revv.app ${release.version} but these sources are ${version}; run `nix run .#update-release v${version}` (or check out the sources of v${release.version}).";

      # Output hashes of nix/node-modules.nix, per platform (bun installs the
      # native optional packages of the platform it runs on). After a
      # bun.lock change, set the hash to `lib.fakeHash`, run
      # `nix build .#node-modules`, and paste the hash from the error.
      nodeModulesHashes = {
        aarch64-darwin = "sha256-1MCBixIpBWy5DtDsIzvoJ/eQi15GFHy8K2Hg4+wOrTM=";
      };

      # What `bun install` needs: the lockfile and every workspace manifest.
      lockfileSources = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./bun.lock
          ./bunfig.toml
          ./apps/collector/package.json
          ./apps/server/package.json
          ./apps/web/package.json
          ./packages/shared/package.json
        ];
      };

      # What the server reads at runtime: its sources, the shared package it
      # imports, and the integration assets it installs for coding agents.
      serverSources = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./bun.lock
          ./bunfig.toml
          ./apps/web/package.json
          ./packages/shared
          ./integrations
          (lib.fileset.fileFilter (file: !lib.hasSuffix ".test.ts" file.name) ./apps/server)
        ];
      };
    in
    {
      packages = forAllSystems (
        pkgs:
        assert releaseMatchesSources;
        let
          inherit (pkgs.stdenv.hostPlatform) system;
          nodeModules = pkgs.callPackage ./nix/node-modules.nix {
            src = lockfileSources;
            hash = nodeModulesHashes.${system};
          };
          revv-server = pkgs.callPackage ./nix/server.nix {
            inherit nodeModules version;
            src = serverSources;
          };
          revv-app = pkgs.callPackage ./nix/app.nix { inherit release system; };
          revv-cli = pkgs.callPackage ./nix/cli.nix { };
        in
        {
          inherit revv-server revv-app revv-cli;
          node-modules = nodeModules;
          # Everything in one profile: Revv.app under Applications/, and
          # `revv-server` and `revv` under bin/.
          default = pkgs.symlinkJoin {
            name = "revv-${version}";
            paths = [
              revv-app
              revv-server
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
