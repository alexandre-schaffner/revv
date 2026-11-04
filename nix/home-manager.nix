# Home Manager module: the Nix equivalent of install.sh.
#
#   imports = [ inputs.revv.homeManagerModules.default ];
#   programs.revv.enable = true;
#
# It installs Revv.app (Home Manager copies or links it into ~/Applications,
# so Spotlight and Launchpad see it), writes the desktop-server.json the app
# reads to start its bundled API server, and puts the `revv` CLI on PATH.
# There is no launchd agent: the app owns the server's lifecycle.
{ revvPackages }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.revv;
  home = config.home.homeDirectory;
  # Same locations as install.sh (scripts/lib/common.sh).
  supportDir = "Library/Application Support/Revv";
  logDir = "${home}/Library/Logs/Revv";
  # Markers of a curl install: the CLI config install.sh writes, and the
  # LaunchAgent installers before 0.32.3 used.
  curlMarkers = [
    "${home}/${supportDir}/config"
    "${home}/Library/LaunchAgents/com.revv.server.plist"
  ];
in
{
  options.programs.revv = {
    enable = lib.mkEnableOption "Revv, the AI-powered code review desktop app";

    package = lib.mkOption {
      type = lib.types.package;
      default = revvPackages.revv-app;
      defaultText = lib.literalExpression "revv.packages.<system>.revv-app";
      description = "The prebuilt Revv.app bundle, which includes the API server.";
    };

    cliPackage = lib.mkOption {
      type = lib.types.package;
      default = revvPackages.revv-cli;
      defaultText = lib.literalExpression "revv.packages.<system>.revv-cli";
      description = "The `revv` management CLI.";
    };

    extraPath = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/opt/homebrew/bin" ];
      description = ''
        Directories prepended to the server's PATH, for coding-agent CLIs
        (claude, codex, opencode, cursor-agent) installed outside Nix. The
        Home Manager and system profiles are on it already.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        GITHUB_HOST = "github.example.com";
        GITHUB_CLIENT_ID = "Iv1…";
      };
      description = ''
        Extra environment for the server, for the overrides install.sh
        accepts (GITHUB_HOST, GITHUB_CLIENT_ID, REVV_CLAUDE_BIN, …). See
        apps/server/src/config.ts for the full list. The port, channel and
        database path are left to the server's defaults.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      (lib.hm.assertions.assertPlatform "programs.revv" pkgs lib.platforms.darwin)
    ];

    home.packages = [
      cfg.package
      cfg.cliPackage
    ];

    # Read by the desktop app at launch (apps/desktop/src/server_config.rs):
    # it starts Contents/MacOS/revv-server with this environment and logs to
    # logDir. A Finder-launched app gets a bare PATH, hence the full one here.
    home.file."${supportDir}/desktop-server.json".text = builtins.toJSON {
      inherit logDir;
      env = {
        PATH = lib.concatStringsSep ":" (
          lib.unique (
            cfg.extraPath
            ++ [
              "${config.home.profileDirectory}/bin"
              "/etc/profiles/per-user/${config.home.username}/bin"
              "/run/current-system/sw/bin"
              "/nix/var/nix/profiles/default/bin"
              "/usr/local/bin"
              "/usr/bin"
              "/bin"
              "/usr/sbin"
              "/sbin"
            ]
          )
        );
        # Updates come from the flake pin: the server answers the app's
        # update check with "nothing to install".
        REVV_UPDATES_MANAGED_BY = "nix";
      }
      // cfg.environment;
    };

    # Before checkLinkTargets, so this explains the conflict instead of Home
    # Manager's generic "existing file is in the way" on desktop-server.json.
    home.activation.revvCheckCurlInstall = lib.hm.dag.entryBefore [ "checkLinkTargets" ] ''
      for marker in ${lib.escapeShellArgs curlMarkers}; do
        [ -e "$marker" ] || continue
        errorEcho "Revv is also installed by install.sh ($marker)."
        errorEcho "Both installs would write the same server configuration. To switch to Nix"
        errorEcho "and keep your database, quit Revv, then remove the curl install's pieces:"
        errorEcho "  - the app in /Applications or ~/Applications (Revv*.app)"
        errorEcho "  - ~/.local/bin/revv and ~/.local/share/revv"
        errorEcho "  - in ~/${supportDir}: config, desktop-server.json, github.conf, src/"
        errorEcho "  - ~/Library/LaunchAgents/com.revv.server.plist, if present"
        errorEcho "Move any GITHUB_HOST / GITHUB_CLIENT_ID from github.conf into programs.revv.environment."
        errorEcho "Do not run 'revv uninstall': it also deletes the database."
        exit 1
      done
    '';
  };
}
