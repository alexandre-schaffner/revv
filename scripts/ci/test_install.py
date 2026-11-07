import hashlib
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
COMMON = ROOT / "scripts/lib/common.sh"

# Stubs for the macOS tools the installer shells out to. quit_revv_app is
# replaced in-process: it reads Info.plist with PlistBuddy and asks the app to
# quit through AppleScript.
STUBS = {
    "launchctl": 'printf "%s\\n" "$*" >> "$STUB_LOG/launchctl"\n',
    "xattr": "exit 0\n",
    "uname": 'if [[ "$1" == "-m" ]]; then echo arm64; else echo Darwin; fi\n',
    "curl": textwrap.dedent(
        """\
        out="" url=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -o) out="$2"; shift 2 ;;
            -*) shift ;;
            *) url="$1"; shift ;;
          esac
        done
        printf "%s\\n" "$url" >> "$STUB_LOG/curl"
        case "$url" in
          */releases/tags/*) cp "$STUB_RELEASE_JSON" "$out" ;;
          */Revv_aarch64.app.tar.gz) cp "$STUB_ARCHIVE" "$out" ;;
          *) exit 22 ;;
        esac
        """
    ),
}


def make_app(path, marker):
    contents = path / "Contents"
    contents.mkdir(parents=True)
    (contents / "marker").write_text(marker)
    return path


class Installer(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.log = self.root / "log"
        self.log.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, body in STUBS.items():
            stub = self.bin / name
            stub.write_text("#!/usr/bin/env bash\n" + body)
            stub.chmod(0o755)
        self.applications = self.root / "Applications"
        self.applications.mkdir()

    def run_installer(self, call, extra_env=None):
        script = textwrap.dedent(
            f"""\
            set -euo pipefail
            source "{COMMON}"
            quit_revv_app() {{ printf "%s\\n" "$1" >> "$STUB_LOG/quit"; }}
            {call}
            printf "INSTALLED=%s\\n" "$REVV_INSTALLED_APP"
            """
        )
        env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "HOME": str(self.home),
            "STUB_LOG": str(self.log),
            "REVV_GITHUB_REPO": "owner/revv",
            **(extra_env or {}),
        }
        return subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)

    def logged(self, name):
        path = self.log / name
        return path.read_text().splitlines() if path.exists() else []

    def leftovers(self):
        return sorted(p.name for p in self.applications.iterdir() if ".tmp." in p.name or ".backup." in p.name)

    def test_fresh_install_copies_the_bundle(self):
        source = make_app(self.root / "build/Revv.app", "new")
        result = self.run_installer(f'install_app_bundle "{source}" "{self.applications}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.applications / "Revv.app"
        self.assertIn(f"INSTALLED={installed}", result.stdout)
        self.assertEqual((installed / "Contents/marker").read_text(), "new")
        self.assertTrue(source.is_dir(), "a local build stays where it was built")
        self.assertEqual(self.logged("quit"), [])

    def test_replaces_the_installed_app_and_quits_it_first(self):
        installed = make_app(self.applications / "Revv.app", "old")
        source = make_app(self.root / "build/Revv.app", "new")
        result = self.run_installer(f'install_app_bundle "{source}" "{self.applications}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((installed / "Contents/marker").read_text(), "new")
        self.assertEqual(self.logged("quit"), [str(installed)])
        self.assertEqual(self.leftovers(), [])

    def test_failed_copy_keeps_the_installed_app(self):
        installed = make_app(self.applications / "Revv.app", "old")
        result = self.run_installer(
            f'if install_app_bundle "{self.root}/missing/Revv.app" "{self.applications}"; then exit 9; fi'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((installed / "Contents/marker").read_text(), "old")
        self.assertEqual(self.leftovers(), [])

    def test_removes_the_app_of_a_renamed_product(self):
        previous = make_app(self.applications / "Revv.app", "old")
        source = make_app(self.root / "build/Revv (Alpha).app", "new")
        result = self.run_installer(f'install_app_bundle "{source}" "{self.applications}" "{previous}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(previous.exists())
        self.assertEqual((self.applications / "Revv (Alpha).app/Contents/marker").read_text(), "new")
        self.assertEqual(self.logged("quit"), [str(previous)])

    def test_keeps_the_previous_app_when_the_name_is_unchanged(self):
        previous = make_app(self.applications / "Revv.app", "old")
        source = make_app(self.root / "build/Revv.app", "new")
        result = self.run_installer(f'install_app_bundle "{source}" "{self.applications}" "{previous}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((previous / "Contents/marker").read_text(), "new")

    @unittest.skipIf(os.geteuid() == 0, "root can write a read-only directory")
    def test_falls_back_to_home_applications_when_not_writable(self):
        self.applications.chmod(0o555)
        self.addCleanup(self.applications.chmod, 0o755)
        source = make_app(self.root / "build/Revv.app", "new")
        result = self.run_installer(f'install_app_bundle "{source}" "{self.applications}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / "Applications/Revv.app/Contents/marker").read_text(), "new")

    def test_stops_the_legacy_launch_agent_but_keeps_its_plist(self):
        plist = self.home / "Library/LaunchAgents/com.revv.server.plist"
        plist.parent.mkdir(parents=True)
        plist.write_text("<plist/>")
        source = make_app(self.root / "build/Revv.app", "new")
        result = self.run_installer(f'install_app_bundle "{source}" "{self.applications}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.logged("launchctl"), [f"unload {plist}"])
        self.assertTrue(plist.exists(), "write_desktop_server_config migrates it later")

    def github_conf(self, env_file="", **overrides):
        support = self.root / "support"
        env = {"REVV_SUPPORT_DIR": str(support), "REVV_INSTALLED_APP": "", **overrides}
        result = self.run_installer(f'save_github_overrides "{env_file}"', env)
        self.assertEqual(result.returncode, 0, result.stderr)
        conf = support / "github.conf"
        return conf.read_text() if conf.exists() else None

    def test_github_overrides_persist_and_clear(self):
        self.assertEqual(
            self.github_conf(REVV_GITHUB_HOST="ghe.example.com", REVV_GITHUB_CLIENT_ID="Iv23li1234567890"),
            "GITHUB_HOST=ghe.example.com\nGITHUB_CLIENT_ID=Iv23li1234567890\n",
        )
        self.assertEqual(self.github_conf(REVV_GITHUB_HOST="ghe2.example.com"), "GITHUB_HOST=ghe2.example.com\n")
        self.assertIsNone(self.github_conf())

    def test_a_checkout_env_file_is_read_only_when_asked(self):
        dotenv = self.root / "checkout/apps/server/.env"
        dotenv.parent.mkdir(parents=True)
        dotenv.write_text('GITHUB_HOST="ghe.dev.test"\nGITHUB_CLIENT_ID=Ov23li1234567890\n')
        self.assertIsNone(self.github_conf())
        self.assertEqual(
            self.github_conf(str(dotenv)), "GITHUB_HOST=ghe.dev.test\nGITHUB_CLIENT_ID=Ov23li1234567890\n"
        )
        self.assertEqual(
            self.github_conf(str(dotenv), REVV_GITHUB_HOST="ghe.example.com"),
            "GITHUB_HOST=ghe.example.com\nGITHUB_CLIENT_ID=Ov23li1234567890\n",
        )

    def release(self, digest=None):
        stage = self.root / "stage"
        make_app(stage / "Revv.app", "release")
        archive = self.root / "Revv_aarch64.app.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            output.add(stage / "Revv.app", arcname="Revv.app")
        sha = digest or hashlib.sha256(archive.read_bytes()).hexdigest()
        url = "https://github.com/owner/revv/releases/download/v1.2.3/Revv_aarch64.app.tar.gz"
        release_json = self.root / "release.json"
        release_json.write_text(
            json.dumps(
                {"assets": [{"name": archive.name, "digest": f"sha256:{sha}", "browser_download_url": url}]},
                indent=2,
            )
        )
        return {"STUB_ARCHIVE": str(archive), "STUB_RELEASE_JSON": str(release_json)}

    def test_release_install_goes_through_the_bundle_install(self):
        previous = make_app(self.applications / "Revv (Old).app", "old")
        result = self.run_installer(
            f'install_release_app v1.2.3 "{self.applications}" "{previous}"', self.release()
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.applications / "Revv.app/Contents/marker").read_text(), "release")
        self.assertFalse(previous.exists())
        self.assertEqual(self.leftovers(), [])

    def test_release_checksum_mismatch_installs_nothing(self):
        result = self.run_installer(f'install_release_app v1.2.3 "{self.applications}"', self.release(digest="0" * 64))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertEqual(list(self.applications.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
