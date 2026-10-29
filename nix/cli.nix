# `revv`, the management CLI for a Nix-installed Revv. The Nix counterpart of
# scripts/revv: same commands where they make sense, but the install itself
# (app bundle, server, launchd agent) belongs to Nix, so `update` explains
# the flake workflow instead of pulling a git checkout.
{
  writeShellApplication,
  agentName ? "revv-server", # launchd.agents.<name> in home-manager.nix
  appName ? "Revv (Alpha)",
}:
writeShellApplication {
  name = "revv";
  text = ''
    label="org.nix-community.home.${agentName}"
    domain="gui/$(id -u)"
    plist="$HOME/Library/LaunchAgents/$label.plist"
    log_dir="$HOME/Library/Logs/Revv"
    data_dir="$HOME/Library/Application Support/Revv"
    api_url="http://localhost:45678"
    app_name="${appName}"
    app_path="$HOME/Applications/Home Manager Apps/$app_name.app"

    usage() {
      cat <<USAGE
    revv - manage the Revv installed by Nix

      revv open      Open $app_name
      revv start     Start the API server (launchd agent)
      revv stop      Stop the API server
      revv restart   Restart the API server
      revv status    Show app, server and agent state
      revv logs      Tail the server logs
      revv path      Print the paths of this install
      revv update    How to update a Nix-managed install
      revv help      This message
    USAGE
    }

    server_up() { curl -fsS --max-time 2 "$api_url/api/health" >/dev/null 2>&1; }

    cmd_open() {
      if [ -d "$app_path" ]; then open "$app_path"; else open -b com.revv.desktop; fi
    }
    cmd_start() {
      [ -f "$plist" ] || { echo "No launchd agent at $plist; is programs.revv enabled?" >&2; exit 1; }
      launchctl bootstrap "$domain" "$plist" 2>/dev/null || launchctl kickstart "$domain/$label"
      echo "started $label"
    }
    cmd_stop() { launchctl bootout "$domain/$label"; echo "stopped $label"; }
    cmd_restart() { launchctl kickstart -k "$domain/$label"; echo "restarted $label"; }
    cmd_status() {
      if [ -d "$app_path" ]; then
        version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist" 2>/dev/null || echo unknown)"
        echo "app:     $app_path ($version)"
      else
        echo "app:     not found at $app_path"
      fi
      if launchctl print "$domain/$label" >/dev/null 2>&1; then
        pid="$(launchctl print "$domain/$label" | awk '/^\tpid = /{print $3}')"
        echo "agent:   $label loaded''${pid:+, pid $pid}"
      else
        echo "agent:   $label not loaded"
      fi
      if server_up; then echo "server:  listening on $api_url"; else echo "server:  not answering on $api_url"; fi
      echo "logs:    $log_dir"
    }
    cmd_logs() { tail -n 50 -F "$log_dir/server.out.log" "$log_dir/server.err.log"; }
    cmd_path() {
      echo "app:    $app_path"
      echo "server: $(readlink -f "$(command -v revv-server)" 2>/dev/null || echo 'revv-server not on PATH')"
      echo "agent:  $plist"
      echo "data:   $data_dir"
      echo "logs:   $log_dir"
    }
    cmd_update() {
      cat <<MSG
    This Revv is installed by Nix, so updates come from your flake:

      nix flake update revv          # in the flake that imports the Revv module
      sudo darwin-rebuild switch ...   # or home-manager switch

    The in-app updater is disabled on Nix installs (REVV_UPDATES_MANAGED_BY=nix).
    MSG
    }

    case "''${1:-help}" in
      open)     cmd_open ;;
      start)    cmd_start ;;
      stop)     cmd_stop ;;
      restart)  cmd_restart ;;
      status)   cmd_status ;;
      logs)     cmd_logs ;;
      path)     cmd_path ;;
      update)   cmd_update ;;
      help|-h|--help) usage ;;
      *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
    esac
  '';
}
