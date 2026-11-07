"""Installer and CLI contract checks: python3 scripts/tests/desktop-server.py"""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
BUN = shutil.which("bun")

class DesktopServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="revv-desktop-config-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source & "workspace"'
        entry = self.source / "apps/server/src/index.ts"
        entry.parent.mkdir(parents=True)
        entry.touch()
        self.support = self.root / "support"
        self.config = self.support / "desktop-server.json"
        self.legacy = self.root / "legacy.plist"
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith("REVV_GITHUB_")},
            "REVV_SUPPORT_DIR": str(self.support),
        }

    def write_config(self):
        subprocess.run([
            "bash", "-c", 'set -euo pipefail; source "$1"; write_desktop_server_config "$2" "$3" "$4" "$5" "$6"',
            "test", str(REPO / "scripts/lib/common.sh"), str(self.config), BUN,
            str(self.source), str(self.root / "logs"), str(self.legacy),
        ], env=self.env, capture_output=True, text=True, check=True)
        return json.loads(self.config.read_text())

    def install(self, overrides=None):
        """The installer's GitHub step then its server step, as install.sh runs them."""
        subprocess.run([
            "bash", "-c", 'set -euo pipefail; source "$1"; save_github_overrides',
            "test", str(REPO / "scripts/lib/common.sh"),
        ], env={**self.env, **(overrides or {})}, capture_output=True, text=True, check=True)
        return self.write_config()["env"]

    def github_env(self, env):
        return {k: v for k, v in env.items() if k.startswith("GITHUB_")}

    def test_config_preserves_paths_and_existing_overrides(self):
        self.support.mkdir()
        (self.support / "github.conf").write_text("GITHUB_HOST=github.company.test\n")
        self.legacy.write_bytes(plistlib.dumps({"EnvironmentVariables": {
            "REVV_DB_PATH": "/custom/revv.db", "GITHUB_HOST": "github.company.test",
            "PATH": "/custom/tools:/usr/bin:/bin",
        }}))
        value = self.write_config()
        self.assertEqual(value["projectRoot"], str(self.source))
        self.assertEqual(value["executable"], BUN)
        self.assertEqual(value["env"]["REVV_DB_PATH"], "/custom/revv.db")
        self.assertEqual(value["env"]["PATH"], "/custom/tools:/usr/bin:/bin")
        self.assertEqual(value["env"]["GITHUB_HOST"], "github.company.test")
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.legacy.unlink()
        self.assertEqual(self.write_config()["env"], value["env"])

    def test_reinstalling_without_a_github_override_removes_it(self):
        ghe = {"REVV_GITHUB_HOST": "ghe.example.com", "REVV_GITHUB_CLIENT_ID": "Iv23li1234567890"}
        self.assertEqual(self.github_env(self.install(ghe)),
                         {"GITHUB_HOST": "ghe.example.com", "GITHUB_CLIENT_ID": "Iv23li1234567890"})
        self.assertEqual(self.github_env(self.write_config()["env"]),
                         {"GITHUB_HOST": "ghe.example.com", "GITHUB_CLIENT_ID": "Iv23li1234567890"},
                         "revv update keeps the persisted override")
        self.assertEqual(self.github_env(self.install({"REVV_GITHUB_HOST": "ghe2.example.com"})),
                         {"GITHUB_HOST": "ghe2.example.com"})
        env = self.install()
        self.assertEqual(self.github_env(env), {})
        self.assertFalse((self.support / "github.conf").exists())
        self.assertEqual(env["REVV_CHANNEL"], "prod")

    def test_cli_start_and_stop_control_the_desktop_app(self):
        cli = (REPO / "scripts/revv").read_text().split('\ncase "${1:-help}" in')[0]
        functions = self.root / "cli-functions.sh"
        functions.write_text(cli)
        app = self.root / "Revv Fixture.app"
        (app / "Contents").mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "revv-desktop"}))
        binaries = self.root / "bin"
        binaries.mkdir()
        for name, text in {
            "open": '#!/bin/bash\nprintf "open %s\\n" "$*" >> "$CALL_LOG"\ntouch "$ALIVE"\n',
            "osascript": '#!/bin/bash\nprintf "quit %s\\n" "$*" >> "$CALL_LOG"\nrm -f "$ALIVE"\n',
            "nc": '#!/bin/bash\ntest -f "$ALIVE"\n',
            "curl": '#!/bin/bash\ntest -f "$ALIVE"\n',
        }.items():
            path = binaries / name
            path.write_text(text)
            path.chmod(0o755)
        calls = self.root / "calls"
        subprocess.run([
            "bash", "-c", 'set -euo pipefail; source "$1"; APP_CANDIDATES=("$2"); '
            'INSTALL_DIR="$3"; SERVER_CONFIG="$4"; LAUNCH_AGENT_PLIST="$5"; '
            'LOG_DIR="$6"; unset __REVV_COMMON_LOADED__; source "$7"; cmd_start; cmd_stop', "test", str(functions), str(app),
            str(self.source), str(self.config), str(self.legacy), str(self.root / "logs"),
            str(REPO / "scripts/lib/common.sh"),
        ], env={**self.env, "PATH": str(binaries) + ":" + os.environ["PATH"],
                "CALL_LOG": str(calls), "ALIVE": str(self.root / "alive")},
            capture_output=True, text=True, check=True)
        actions = calls.read_text()
        self.assertIn("open -g " + str(app) + " --args --hidden", actions)
        self.assertIn("quit ", actions)
        self.assertFalse((self.root / "alive").exists())
        self.assertFalse(self.legacy.exists())
        self.assertTrue(self.config.exists())

if __name__ == "__main__":
    unittest.main()
