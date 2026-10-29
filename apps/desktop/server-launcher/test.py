"""Verify a built helper: python3 apps/desktop/server-launcher/test.py <Revv.app>"""

import json
import os
from pathlib import Path
import plistlib
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest


APP = Path(sys.argv.pop(1)).resolve()
REPO = Path(__file__).resolve().parents[3]
BUN = shutil.which("bun")


class ServerLauncherTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert BUN, "bun must be on PATH"
        cls.temp = tempfile.TemporaryDirectory(prefix="revv-launcher-")
        cls.root = Path(cls.temp.name).resolve()
        cls.launcher = APP / "Contents/MacOS/revv-server"
        cls.project = cls.root / "source & workspace"
        entry = cls.project / "apps/server/src/index.ts"
        entry.parent.mkdir(parents=True)
        entry.write_text("""
console.log(JSON.stringify({pid: process.pid, parent: process.ppid,
  cwd: process.cwd(), marker: process.env.REVV_LAUNCHER_TEST}));
console.error("server stderr");
if (process.env.REVV_LAUNCHER_WAIT) setInterval(() => {}, 1000);
else process.exit(Number(process.env.REVV_LAUNCHER_EXIT || 0));
""")
        inspector = cls.root / "inspect.m"
        inspector.write_text("""
#import <AppKit/AppKit.h>
int main(int argc, char *argv[]) {
    @autoreleasepool {
        NSRunningApplication *app = [NSRunningApplication
            runningApplicationWithProcessIdentifier:atoi(argv[1])];
        if (!app || ![app.localizedName isEqualToString:@"Revv"] ||
            ![app.bundleIdentifier isEqualToString:@"com.revv.server"] ||
            !app.icon || app.activationPolicy != NSApplicationActivationPolicyProhibited)
            return 1;
        puts(app.bundleURL.fileSystemRepresentation);
        return 0;
    }
}
""")
        cls.inspector = cls.root / "inspect"
        subprocess.run(["xcrun", "clang", "-fobjc-arc", "-framework", "AppKit",
                        str(inspector), "-o", str(cls.inspector)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def start_server(self, **env):
        child = subprocess.Popen(
            [str(self.launcher), BUN], cwd=self.project,
            env={**os.environ, "REVV_LAUNCHER_TEST": "inherited", **env},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        self.addCleanup(self.stop_server, child)
        self.assertTrue(select.select([child.stdout], [], [], 10)[0], "server did not start")
        state = json.loads(child.stdout.readline())
        return child, state

    @staticmethod
    def stop_server(child):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()

    def test_application_identity_and_icon(self):
        child, state = self.start_server(REVV_LAUNCHER_WAIT="1")
        result = subprocess.run([str(self.inspector), str(child.pid)],
                                capture_output=True, text=True, check=True)
        self.assertEqual(Path(result.stdout.strip()), APP)
        self.assertEqual(state["parent"], child.pid)
        self.assertEqual(os.getpgid(state["pid"]), child.pid)
        self.assertEqual((APP / "Contents/Resources/icon.icns").read_bytes(),
                         (REPO / "apps/desktop/icons/icon.icns").read_bytes())
        subprocess.run(["codesign", "--verify", "--strict", str(APP)], check=True)

    def test_environment_cwd_logs_and_exit_status(self):
        child, state = self.start_server(REVV_LAUNCHER_EXIT="23")
        self.assertEqual(state["cwd"], str(self.project))
        self.assertEqual(state["marker"], "inherited")
        self.assertEqual(child.wait(timeout=5), 23)
        self.assertEqual(child.stderr.read(), "server stderr\n")

    def test_signal_exit_status(self):
        child, state = self.start_server(REVV_LAUNCHER_WAIT="1")
        os.kill(state["pid"], signal.SIGTERM)
        self.assertEqual(child.wait(timeout=5), 128 + signal.SIGTERM)

    def test_stop_terminates_process_group(self):
        child, state = self.start_server(REVV_LAUNCHER_WAIT="1")
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=5)
        # A zombie may briefly remain while launchd reaps the child; it cannot run work.
        status = subprocess.run(["ps", "-o", "stat=", "-p", str(state["pid"])],
                                capture_output=True, text=True).stdout.strip()
        self.assertTrue(not status or status.startswith("Z"), status)

    def test_invalid_arguments_and_spawn_failure(self):
        for args, expected in [([], 2), (["/missing/bun"], 1), ([BUN, "extra"], 2)]:
            result = subprocess.run([str(self.launcher), *args], capture_output=True)
            self.assertEqual(result.returncode, expected)
            self.assertTrue(result.stderr)

    def test_installer_launches_bundled_helper(self):
        installed_app = self.root / "Revv & Alpha.app"
        helper = installed_app / "Contents/Helpers/Revv.app"
        helper.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(APP, helper)
        plist_path = self.root / "server.plist"
        subprocess.run([
            "bash", "-c", 'set -euo pipefail; source "$1"; '
            'write_launch_agent_plist "$2" "$3" "$4" "$5" "$6"', "test",
            str(REPO / "scripts/lib/common.sh"), str(plist_path), BUN,
            str(self.project), str(self.root / "logs"), str(installed_app),
        ], env={**os.environ, "REVV_SUPPORT_DIR": str(self.root / "support")},
            check=True, capture_output=True)
        with plist_path.open("rb") as file:
            plist = plistlib.load(file)
        self.assertEqual(plist["ProgramArguments"],
                         [str(helper / "Contents/MacOS/revv-server"), BUN])
        self.assertEqual(plist["WorkingDirectory"], str(self.project))
        # Run exactly the generated command without touching the installed service or DB.
        result = subprocess.run(plist["ProgramArguments"], cwd=plist["WorkingDirectory"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["cwd"], str(self.project))


if __name__ == "__main__":
    unittest.main()
