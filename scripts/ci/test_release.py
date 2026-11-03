import copy
import hashlib
import json
import importlib.util
import io
import os
import pathlib
import plistlib
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/release"))
from artifacts import validate_archive, validate_set

spec = importlib.util.spec_from_file_location("trusted_run", ROOT / "scripts/ci/trusted-run.py")
trusted_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trusted_run)


def archive(path, version="1.2.3", arch=0x0100000C, extra=None, server_arch=None, server=True):
    with tarfile.open(path, "w:gz") as output:
        files = {
            "Revv.app/Contents/Info.plist": plistlib.dumps({"CFBundleShortVersionString": version, "CFBundleExecutable": "revv-desktop"}),
            "Revv.app/Contents/MacOS/revv-desktop": struct.pack("<II", 0xFEEDFACF, arch),
        }
        if server:
            files["Revv.app/Contents/MacOS/revv-server"] = struct.pack("<II", 0xFEEDFACF, server_arch or arch)
        if extra:
            files.update(extra)
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            output.addfile(member, io.BytesIO(data))


class Artifacts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = pathlib.Path(self.temp.name)
        self.path = self.directory / "Revv_aarch64.app.tar.gz"
        archive(self.path)

    def test_correct_archive(self):
        validate_archive(self.path, "1.2.3", "aarch64")

    def test_wrong_version(self):
        with self.assertRaisesRegex(ValueError, "version"):
            validate_archive(self.path, "1.2.4", "aarch64")

    def test_wrong_architecture(self):
        with self.assertRaisesRegex(ValueError, "architecture"):
            validate_archive(self.path, "1.2.3", "x64")

    def test_missing_bundled_server(self):
        archive(self.path, server=False)
        with self.assertRaisesRegex(ValueError, "Missing Bundled server"):
            validate_archive(self.path, "1.2.3", "aarch64")

    def test_bundled_server_for_another_architecture(self):
        archive(self.path, server_arch=0x01000007)
        with self.assertRaisesRegex(ValueError, "Bundled server architecture"):
            validate_archive(self.path, "1.2.3", "aarch64")

    def test_unsafe_archive(self):
        archive(self.path, extra={"../outside": b"unsafe"})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            validate_archive(self.path, "1.2.3", "aarch64")

    def test_rejects_unexpected_release_asset(self):
        for arch, cpu in [("aarch64", 0x0100000C), ("x64", 0x01000007)]:
            (self.directory / f"Revv_1.2.3_{arch}.dmg").write_bytes(b"dmg")
            archive(self.directory / f"Revv_{arch}.app.tar.gz", arch=cpu)
        (self.directory / "unexpected.sh").write_text("echo unsafe")
        with self.assertRaisesRegex(ValueError, "asset set"):
            validate_set(self.directory, "1.2.3")

    def test_missing_architecture(self):
        with self.assertRaisesRegex(ValueError, "Missing"):
            validate_set(self.directory, "1.2.3")

    def test_complete_set(self):
        for arch, cpu in [("aarch64", 0x0100000C), ("x64", 0x01000007)]:
            (self.directory / f"Revv_1.2.3_{arch}.dmg").write_bytes(b"dmg")
            archive(self.directory / f"Revv_{arch}.app.tar.gz", arch=cpu)
        self.assertEqual(len(validate_set(self.directory, "1.2.3")), 4)

    def test_installer_rejects_missing_dmg(self):
        root = self.directory / "source"
        (root / "scripts/release").mkdir(parents=True)
        for name in ["scripts/release/build-installer.sh", "scripts/release/install.sh.tmpl", "install.sh"]:
            shutil.copyfile(ROOT / name, root / name)
        env = dict(os.environ, RELEASE_TAG="v1.2.3", REVV_VERSION="1.2.3", BUNDLE_DIR=str(self.directory))
        result = subprocess.run(["bash", str(root / "scripts/release/build-installer.sh")], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root / "dist/install.sh").exists())

    def test_installer_contains_both_checksums(self):
        root = self.directory / "source"
        (root / "scripts/release").mkdir(parents=True)
        for name in ["scripts/release/build-installer.sh", "scripts/release/install.sh.tmpl", "install.sh"]:
            shutil.copyfile(ROOT / name, root / name)
        for arch in ["aarch64", "x64"]:
            (self.directory / f"Revv_1.2.3_{arch}.dmg").write_bytes(arch.encode())
        env = dict(os.environ, RELEASE_TAG="v1.2.3", REVV_VERSION="1.2.3", BUNDLE_DIR=str(self.directory))
        subprocess.run(["bash", str(root / "scripts/release/build-installer.sh")], env=env, check=True)
        sums = (root / "dist/SHA256SUMS").read_text()
        self.assertIn("Revv_1.2.3_aarch64.dmg", sums)
        self.assertIn("Revv_1.2.3_x64.dmg", sums)
        self.assertNotIn("MISSING", (root / "dist/install.sh").read_text())


class TrustedRun(unittest.TestCase):
    def setUp(self):
        self.run = {"repository": {"full_name": "owner/revv"}, "head_repository": {"full_name": "owner/revv"}, "workflow_id": 42, "event": "push", "head_branch": "main", "status": "completed", "conclusion": "success", "head_sha": "a" * 40}

    def test_trusted_run(self):
        self.assertEqual(trusted_run.validate_run(self.run, "owner/revv", 42), "a" * 40)

    def test_rejects_untrusted_events(self):
        for field, value in [("event", "pull_request"), ("head_branch", "feature"), ("workflow_id", 43), ("status", "in_progress"), ("conclusion", "failure"), ("head_sha", "bad")]:
            with self.subTest(field=field):
                run = dict(self.run, **{field: value})
                with self.assertRaises(ValueError):
                    trusted_run.validate_run(run, "owner/revv", 42)

    def test_rejects_fork(self):
        run = copy.deepcopy(self.run)
        run["head_repository"]["full_name"] = "attacker/revv"
        with self.assertRaises(ValueError):
            trusted_run.validate_run(run, "owner/revv", 42)

    def test_recovers_draft_without_published_tag_endpoint(self):
        self.recover(draft=True)

    def test_recovery_refuses_published_release(self):
        with self.assertRaisesRegex(ValueError, "draft release"):
            self.recover(draft=False)

    def recover(self, *, draft):
        def transport(args, **kwargs):
            if args[:3] == ["gh", "release", "view"]:
                return json.dumps({"isDraft": draft})
            path = args[2]
            if path.endswith("/actions/workflows/ci.yml"):
                return json.dumps({"id": 42})
            if "/git/ref/tags/" in path:
                return json.dumps({"object": {"type": "commit", "sha": "a" * 40}})
            if "/actions/workflows/ci.yml/runs?" in path:
                return json.dumps({"workflow_runs": [dict(self.run, id=123)]})
            if "/compare/" in path:
                return json.dumps({"status": "identical"})
            raise subprocess.CalledProcessError(1, args, stderr="Not Found (HTTP 404)")

        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "output"
            env = {"GH_REPO": "owner/revv", "RECOVERY_TAG": "v1.2.3", "CI_RUN_ID": "", "GITHUB_OUTPUT": str(output)}
            with mock.patch.dict(os.environ, env), mock.patch.object(trusted_run.subprocess, "check_output", side_effect=transport):
                trusted_run.main()
            self.assertEqual(output.read_text(), f"sha={'a' * 40}\nci_run_id=123\n")

    def test_rejects_wrong_sha(self):
        with self.assertRaises(ValueError):
            trusted_run.validate_run(self.run, "owner/revv", 42, "b" * 40)


publish_spec = importlib.util.spec_from_file_location("release_publish", ROOT / "scripts/release/publish.py")
release_publish = importlib.util.module_from_spec(publish_spec)
publish_spec.loader.exec_module(release_publish)


class Publication(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = pathlib.Path(self.temp.name)
        (self.directory / "asset.dmg").write_bytes(b"verified bytes")
        self.calls = []

    def transport(self, *, corrupt=False, upload_failure=False, extra_after_upload=False):
        def gh(*args):
            self.calls.append(args)
            if args[:2] == ("release", "view"):
                return json.dumps({"databaseId": 42, "assets": [{"name": "old.dmg"}]})
            if args[:2] == ("release", "upload") and upload_failure:
                raise subprocess.CalledProcessError(1, args)
            if args[0] == "api":
                # GitHub's tag endpoint returns 404 while the release is a draft.
                if args[1] != "repos/test/revv/releases/42":
                    raise subprocess.CalledProcessError(1, args, stderr="Not Found (HTTP 404)")
                assets = [{"name": "asset.dmg", "size": 14, "digest": "sha256:" + hashlib.sha256(b"wrong contents" if corrupt else b"verified bytes").hexdigest()}]
                if extra_after_upload:
                    assets.append({"name": "unexpected.dmg", "size": 1})
                return json.dumps({"assets": assets, "immutable": True})
            return ""
        return gh

    def execute(self, **kwargs):
        with mock.patch.object(release_publish, "gh", side_effect=self.transport(**kwargs)), mock.patch.dict(os.environ, {"GH_REPO": "test/revv"}):
            release_publish.publish(self.directory, "v1.2.3", False)

    def test_missing_signing_key_stops_before_external_commands(self):
        for key in ["", "   "]:
            with self.subTest(key=key), mock.patch.dict(os.environ, {"TAURI_SIGNING_PRIVATE_KEY": key}), mock.patch.object(sys, "argv", ["publish.py", "prepare"]), mock.patch.object(release_publish.subprocess, "check_output") as check_output, mock.patch.object(release_publish.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "Missing release signing key"):
                    release_publish.main()
                check_output.assert_not_called()
                run.assert_not_called()

    def test_removes_stale_draft_assets_before_upload(self):
        self.execute()
        self.assertLess(self.calls.index(("release", "delete-asset", "v1.2.3", "old.dmg", "--yes")), next(i for i, c in enumerate(self.calls) if c[:2] == ("release", "upload")))
        self.assertTrue(any(c[:2] == ("release", "edit") for c in self.calls))

    def test_upload_failure_never_publishes(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(upload_failure=True)
        self.assertFalse(any(c[:2] == ("release", "edit") for c in self.calls))

    def test_corruption_never_publishes(self):
        with self.assertRaisesRegex(ValueError, "corrupted"):
            self.execute(corrupt=True)
        self.assertFalse(any(c[:2] == ("release", "edit") for c in self.calls))

    def test_unexpected_assets_never_publish(self):
        with self.assertRaisesRegex(ValueError, "exactly"):
            self.execute(extra_after_upload=True)
        self.assertFalse(any(c[:2] == ("release", "edit") for c in self.calls))
