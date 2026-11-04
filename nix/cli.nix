# `revv`, the management CLI for a Nix-installed Revv. The Nix counterpart of
# scripts/revv, minus what Nix owns: the desktop app starts and stops its
# bundled server, and updates come from the flake, so there is no
# start/stop/update/uninstall here.
{
  lib,
  writeShellApplication,
  curl,
  app,
  apiPort,
}:
writeShellApplication {
  name = "revv";
  runtimeInputs = [ curl ];
  text = ''
    # Read from the pinned bundle so a renamed product or identifier needs no edit here.
    store_app="$(echo ${lib.escapeShellArg "${app}/Applications"}/*.app)"
    info="$store_app/Contents/Info.plist"
    bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info")"
    app_name="$(basename "$store_app" .app)"
    pinned_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info")"

    data_dir="$HOME/Library/Application Support/Revv"
    log_dir="$HOME/Library/Logs/Revv"
    api_url="http://localhost:${toString apiPort}"

    usage() {
      cat <<USAGE
    revv - manage the Revv installed by Nix

      revv open      Open $app_name (it starts the API server)
      revv status    Show the pinned app and whether its server answers
      revv logs      Tail the server logs
      revv path      Print the paths of this install
      revv update    How to update a Nix-managed install
      revv help      This message
    USAGE
    }

    cmd_open() { open -b "$bundle_id"; }
    cmd_status() {
      echo "app:     $app_name $pinned_version (pinned by Nix)"
      if health="$(curl -fsS --max-time 2 "$api_url/api/health" 2>/dev/null)"; then
        echo "server:  listening on $api_url ($health)"
      else
        echo "server:  not answering on $api_url; it runs while $app_name is open"
      fi
      echo "logs:    $log_dir"
    }
    cmd_logs() { tail -n 50 -F "$log_dir/server.out.log" "$log_dir/server.err.log"; }
    cmd_path() {
      echo "app:    $store_app"
      echo "config: $data_dir/desktop-server.json"
      echo "data:   $data_dir"
      echo "logs:   $log_dir"
    }
    cmd_update() {
      cat <<MSG
    This Revv is installed by Nix, so updates come from your flake:

      nix flake update revv            # in the flake that imports the Revv module
      darwin-rebuild switch ...        # or home-manager switch

    The in-app updater is disabled on Nix installs (REVV_UPDATES_MANAGED_BY=nix).
    MSG
    }

    case "''${1:-help}" in
      open)     cmd_open ;;
      status)   cmd_status ;;
      logs)     cmd_logs ;;
      path)     cmd_path ;;
      update)   cmd_update ;;
      help|-h|--help) usage ;;
      *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
    esac
  '';
}
