# Home Manager module: the Nix equivalent of install.sh.
#
#   imports = [ inputs.revv.homeManagerModules.default ];
#   programs.revv.enable = true;
#
# It installs Revv.app (Home Manager copies it to ~/Applications/Home Manager
# Apps, so Spotlight and Launchpad see it), runs the API server as a launchd
# agent with the same environment install.sh writes into com.revv.server,
# and puts the `revv` CLI on PATH.
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
  logDir = "${home}/Library/Logs/Revv";
  dataDir = "${home}/Library/Application Support/Revv";
  # Name of the launchd agent; nix/cli.nix derives the label from it.
  agentName = "revv-server";
  legacyPlist = "${home}/Library/LaunchAgents/com.revv.server.plist";
in
{
  options.programs.revv = {
    enable = lib.mkEnableOption "Revv, the AI-powered code review desktop app";

    package = lib.mkOption {
      type = lib.types.package;
      default = revvPackages.revv-server;
      defaultText = lib.literalExpression "revv.packages.<system>.revv-server";
      description = "The API server package; provides `revv-server`.";
    };

    desktopPackage = lib.mkOption {
      type = lib.types.package;
      default = revvPackages.revv-app;
      defaultText = lib.literalExpression "revv.packages.<system>.revv-app";
      description = "The prebuilt Revv.app bundle.";
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
        apps/server/src/config.ts for the full list.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      (lib.hm.assertions.assertPlatform "programs.revv" pkgs lib.platforms.darwin)
    ];

    home.packages = [
      cfg.desktopPackage
      cfg.package
      cfg.cliPackage
    ];

    launchd.agents.${agentName} = {
      enable = true;
      config = {
        ProgramArguments = [ "${cfg.package}/bin/revv-server" ];
        EnvironmentVariables = {
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
          HOME = home;
          REVV_CHANNEL = "prod";
          PORT = "45678";
          REVV_DB_PATH = "${dataDir}/revv.db";
          # Updates come from the flake pin; tells the server to answer the
          # desktop app's update check with "nothing to install".
          REVV_UPDATES_MANAGED_BY = "nix";
        }
        // cfg.environment;
        RunAtLoad = true;
        KeepAlive = {
          SuccessfulExit = false;
          Crashed = true;
        };
        ThrottleInterval = 10;
        StandardOutPath = "${logDir}/server.out.log";
        StandardErrorPath = "${logDir}/server.err.log";
      };
    };

    home.activation.revvSetup = lib.hm.dag.entryBefore [ "setupLaunchAgents" ] ''
      # launchd creates the log files but not their directory.
      run mkdir -p ${lib.escapeShellArg logDir} ${lib.escapeShellArg dataDir}

      # A curl-installed Revv runs its own com.revv.server agent on the same
      # port and database; the two would keep killing each other.
      if [ -f ${lib.escapeShellArg legacyPlist} ]; then
        errorEcho "Revv is also installed by install.sh (${legacyPlist})."
        errorEcho "Remove that install first: run 'revv uninstall' with its CLI,"
        errorEcho "or 'launchctl bootout gui/$(id -u)/com.revv.server' and delete the plist and /Applications/Revv*.app."
        exit 1
      fi
    '';
  };
}
