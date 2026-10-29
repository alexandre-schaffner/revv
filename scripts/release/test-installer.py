"""Exercise release preflight without installing anything or using the network."""

import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


TEMPLATE = Path(__file__).with_name("install.sh.tmpl").read_text()
VERSION = "2.103.3"
PINS = {
    "arm64": "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062",
    "amd64": "a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682",
}
VERIFIER = '''#!/bin/bash
if [[ "$*" == "attestation verify --help" ]]; then exit 0; fi
host="$(
  host="${GH_HOST:-github.com}"
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--hostname" ]]; then host="$2"; break; fi
    shift
  done
  printf '%s' "$host"
)"
if [[ "$host" != "github.com" || -f "${GH_CONFIG_DIR:-$HOME/.config/gh}/reject-verification" || -f "${XDG_CACHE_HOME:-$HOME/.cache}/gh/reject-verification" ]]; then
  echo 'Error: verifying with issuer "sigstore.dev"' >&2
  exit 1
fi
printf '%s\\n' "$@" >> "$TEST_ROOT/verify-args"
exit "${TEST_VERIFY_FAIL:-0}"
'''


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="revv-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        for command in ("bash", "awk", "chmod", "mktemp", "rm", "shasum", "unzip"):
            (self.bin / command).symlink_to(shutil.which(command))
        self.executable("uname", '#!/bin/bash\nif [[ "$1" == "-s" ]]; then echo Darwin; else echo "${TEST_ARCH:-arm64}"; fi\n')
        self.executable("curl", f'''#!{sys.executable}
import os
from pathlib import Path
import shutil
import sys
root = Path(os.environ["TEST_ROOT"])
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith("https://"))
with (root / "downloads").open("a") as log:
    log.write(url + "\\n")
if os.environ.get("TEST_DOWNLOAD_FAIL") or (os.environ.get("TEST_BOOTSTRAP_FAIL") and url.endswith(".zip")):
    sys.exit(22)
if url.endswith("install.sh.sigstore"):
    source = root / "bundle"
elif url.endswith("install.sh"):
    source = root / "install.sh"
else:
    arch = "arm64" if "arm64" in url else "amd64"
    source = root / (arch + ".zip")
shutil.copyfile(source, args[args.index("-o") + 1])
''')
        template = TEMPLATE
        for arch, pin in PINS.items():
            archive = self.root / f"{arch}.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr(f"gh_{VERSION}_macOS_{arch}/bin/gh", VERIFIER)
            template = template.replace(pin, hashlib.sha256(archive.read_bytes()).hexdigest())
        self.installer = self.root / "install.sh"
        self.installer.write_text(template.replace("@@REVV_VERSION@@", "0.0.0").replace("@@RELEASE_TAG@@", "v0.0.0") + "\nprintf '%s' \"$HOME\" > \"$TEST_ROOT/install-home\"\nprintf 'INSTALL_REACHED\\n'\n")
        (self.root / "bundle").write_text("{}")
        self.env = {
            "PATH": str(self.bin), "HOME": str(self.root), "TMPDIR": str(self.scratch),
            "TEST_ROOT": str(self.root),
        }

    def executable(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def run_installer(self, *args, piped=False, **env):
        result = subprocess.run(
            ["/bin/bash", *args] if piped else ["/bin/bash", str(self.installer), *args],
            input=self.installer.read_text() if piped else None,
            env={**self.env, **env}, text=True, capture_output=True,
        )
        self.assertEqual(list(self.scratch.iterdir()), [], result.stdout + result.stderr)
        return result

    def assert_verified(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("INSTALL_REACHED", result.stdout)
        self.assertEqual((self.root / "install-home").read_text(), str(self.root))
        args = (self.root / "verify-args").read_text()
        self.assertIn("attestation\nverify\n", args)
        self.assertIn("--repo\nalexandre-schaffner/revv\n--bundle\n", args)

    def test_no_gh_on_apple_silicon(self):
        self.assert_verified(self.run_installer())
        self.assertIn(f"gh_{VERSION}_macOS_arm64.zip", (self.root / "downloads").read_text())

    def test_no_gh_on_intel(self):
        self.assert_verified(self.run_installer(TEST_ARCH="x86_64"))
        self.assertIn(f"gh_{VERSION}_macOS_amd64.zip", (self.root / "downloads").read_text())

    def test_curl_pipe(self):
        self.assert_verified(self.run_installer(piped=True))

    def test_github_enterprise_default_does_not_affect_public_release(self):
        self.assert_verified(self.run_installer(piped=True, GH_HOST="company.ghe.com"))

    def test_existing_verifier_state_is_not_used(self):
        for variable in ("GH_CONFIG_DIR", "XDG_CACHE_HOME"):
            with self.subTest(variable=variable):
                state = self.root / variable
                cache = state / "gh" if variable == "XDG_CACHE_HOME" else state
                cache.mkdir(parents=True)
                (cache / "reject-verification").write_text("stale state")
                self.assert_verified(self.run_installer(piped=True, **{variable: str(state)}))

    def test_installed_gh_is_ignored_even_if_it_supports_attestations(self):
        self.executable("gh", '''#!/bin/bash
printf called > "$TEST_ROOT/system-gh"
if [[ "$*" == "attestation verify --help" ]]; then exit 0; fi
echo 'Error: verifying with issuer "sigstore.dev"' >&2
exit 1
''')
        self.assert_verified(self.run_installer())
        self.assertFalse((self.root / "system-gh").exists())
        self.assertIn("macOS_arm64.zip", (self.root / "downloads").read_text())

    def test_old_gh_bootstraps_verifier(self):
        self.executable("gh", "#!/bin/bash\nexit 1\n")
        self.assert_verified(self.run_installer())

    def test_corrupt_archive_is_rejected_before_execution(self):
        (self.root / "arm64.zip").write_bytes(b"corrupt")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertNotIn("INSTALL_REACHED", result.stdout)
        self.assertFalse((self.root / "verify-args").exists())

    def test_verification_failure_stops_install(self):
        result = self.run_installer(TEST_VERIFY_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("verification failed", result.stderr)
        self.assertNotIn("INSTALL_REACHED", result.stdout)

    def test_download_failure_stops_install(self):
        result = self.run_installer(TEST_DOWNLOAD_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("INSTALL_REACHED", result.stdout)

    def test_bootstrap_download_failure_stops_install(self):
        result = self.run_installer(TEST_BOOTSTRAP_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not download GitHub CLI", result.stderr)
        self.assertNotIn("INSTALL_REACHED", result.stdout)
        self.assertFalse((self.root / "verify-args").exists())

    def test_piped_verification_failure_stops_install(self):
        result = self.run_installer(piped=True, TEST_VERIFY_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("INSTALL_REACHED", result.stdout)

    def test_skip_requires_both_opt_ins(self):
        self.assert_verified(self.run_installer("--skip-verify"))
        (self.root / "downloads").unlink()
        self.assert_verified(self.run_installer(REVV_SKIP_VERIFY="1"))
        (self.root / "downloads").unlink()
        result = self.run_installer("--skip-verify", REVV_SKIP_VERIFY="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "downloads").exists())

    def test_help_does_not_download(self):
        result = self.run_installer("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "downloads").exists())


if __name__ == "__main__":
    unittest.main()
