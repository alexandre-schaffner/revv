{
  description = "Revv dev environment (Bun + Rust/Tauri)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-compat = {
      url = "github:edolstra/flake-compat";
      flake = false;
    };
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
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

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
