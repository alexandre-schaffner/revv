"""Configure the existing macOS Revv LaunchAgent; no application DB writes."""
from pathlib import Path
import os
import plistlib
import shutil
import subprocess
import sys

base = Path.home() / ".revv/telemetry"
service = Path.home() / "Library/LaunchAgents/com.revv.server.plist"
data = plistlib.loads(service.read_bytes())
backup = base / "backups/server-before-profiling.plist"
backup.parent.mkdir(parents=True, exist_ok=True)
if not backup.exists():
    shutil.copy2(service, backup)
data.setdefault("EnvironmentVariables", {})["REVV_PYROSCOPE_ENDPOINT"] = "http://127.0.0.1:4040"
runtime = Path(data["WorkingDirectory"]) / "apps/server/src/runtime.ts"
preload = str(base / "profiling/preload.js")
args = data["ProgramArguments"]
# A new app version owns the layer itself. Remove only our own older preload.
if preload in args:
    index = args.index(preload)
    if index > 0 and args[index - 1] == "--preload":
        del args[index - 1:index + 1]
if "ContinuousProfilingLive" not in runtime.read_text():
    index = 2 if len(args) > 1 and args[1] == "run" else 1
    args[index:index] = ["--preload", preload]
service.write_bytes(plistlib.dumps(data))
if "--restart" in sys.argv:
    domain = "gui/" + str(os.getuid())
    subprocess.run(["launchctl", "bootout", domain, str(service)], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(service)], check=True)
print("Installed Revv profiling configured" + (" and restarted" if "--restart" in sys.argv else "; takes effect on next server restart"))
