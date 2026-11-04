#!/usr/bin/env bash
# Checks the Nix flake on an aarch64-darwin machine with Nix: the flake
# evaluates, the pinned Revv.app downloads with its hash and carries the
# bundled server, the CLI passes shellcheck, and the Home Manager module
# builds a desktop-server.json the desktop app accepts.
#
#   bash scripts/ci/nix-check.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

nix flake check --no-build
nix build --out-link "$work/revv" .#default
"$work/revv/bin/revv" help >/dev/null
"$work/revv/bin/revv" path

# Home Manager isn't a flake input (consumers bring their own), so the module
# is evaluated here against home-manager's current release branch.
nix build --impure --out-link "$work/home" --expr "
  let
    revv = builtins.getFlake \"git+file://$root\";
    hm = builtins.getFlake \"github:nix-community/home-manager\";
    pkgs = revv.inputs.nixpkgs.legacyPackages.aarch64-darwin;
  in
  (hm.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      revv.homeManagerModules.default
      {
        home = { username = \"ci\"; homeDirectory = \"/Users/ci\"; stateVersion = \"25.11\"; };
        programs.revv = {
          enable = true;
          extraPath = [ \"/opt/homebrew/bin\" ];
          environment.GITHUB_HOST = \"github.example.com\";
        };
      }
    ];
  }).activationPackage
"

config="$work/home/home-files/Library/Application Support/Revv/desktop-server.json"
jq . "$config"
# The fields apps/desktop/src/server_config.rs requires, and what the module promises.
jq -e '
  (.logDir | startswith("/"))
  and (.env | type == "object")
  and (.env | to_entries | all(.value | type == "string"))
  and .env.REVV_UPDATES_MANAGED_BY == "nix"
  and .env.GITHUB_HOST == "github.example.com"
  and (.env.PATH | startswith("/opt/homebrew/bin:"))
  and (has("executable") | not)
  and (has("projectRoot") | not)
' "$config" >/dev/null

echo "nix flake ok"
