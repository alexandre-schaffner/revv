"""Exercise Turbo's real task hashes in an isolated copy of the current tree."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[2]


def run(*args, cwd, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout


def main():
    with tempfile.TemporaryDirectory(prefix="revv-cache-") as temp:
        checkout = pathlib.Path(temp)
        names = run("git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", cwd=ROOT).split("\0")
        for name in names:
            if not name:
                continue
            source = ROOT / name
            if not source.is_file():
                continue
            destination = checkout / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        (checkout / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        run("git", "init", "-q", cwd=checkout)
        run("git", "add", ".", cwd=checkout)

        def commit():
            run("git", "-c", "user.name=Cache verification", "-c", "user.email=cache@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "cache probe", "--allow-empty", cwd=checkout)

        commit()

        def hashes(extra=None):
            env = dict(os.environ, **(extra or {}))
            data = json.loads(run("bun", "--no-env-file", "scripts/turbo.mjs", "run", "build", "typecheck", "--dry=json", cwd=checkout, env=env))
            return {task["taskId"]: task["hash"] for task in data["tasks"]}

        def changed(before, after):
            return {key for key in before if before[key] != after[key]}

        baseline = hashes()
        assert hashes() == baseline, "Unchanged inputs must reuse hashes"
        commit()
        current = hashes()
        assert changed(baseline, current) == {"@revv/web#build"}, "Commit changes must invalidate only the frontend build"

        def probe(file, transform, expected):
            path = checkout / file
            original = path.read_text()
            try:
                path.write_text(transform(original))
                actual = changed(current, hashes())
                assert expected <= actual, f"{file}: expected invalidation {expected}, got {actual}"
            finally:
                path.write_text(original)

        probe("tsconfig.base.json", lambda s: s.replace('"ESNext"', '"ES2022"'), set(current))
        probe("packages/shared/src/index.ts", lambda s: s + "\n// cache probe\n", set(current) - {"@revv/web#sync"})
        probe("apps/server/src/index.ts", lambda s: s + "\n// cache probe\n", {"@revv/server#build", "@revv/server#typecheck", "@revv/web#typecheck"})
        direct = str(ROOT / "node_modules/.bin/turbo")
        def runtime_hashes(runtime):
            env = dict(os.environ, REVV_BUILD_RUNTIME=runtime, REVV_BUILD_SHA="a" * 40)
            data = json.loads(run(direct, "run", "build", "typecheck", "--dry=json", cwd=checkout, env=env))
            return {task["taskId"]: task["hash"] for task in data["tasks"]}
        assert changed(runtime_hashes("linux-x64-bun-1"), runtime_hashes("linux-x64-bun-2")) == set(current)
        probe("bun.lock", lambda s: s.replace("2.5.14", "2.5.13"), set(current))
        probe("bun.lock", lambda s: s.replace('"effect@4.0.3"', '"effect@4.0.2"'), {"@revv/server#build", "@revv/server#typecheck", "@revv/web#typecheck"})
        assert "@revv/web#build" in changed(hashes({"VITE_API_PORT": "45678"}), hashes({"VITE_API_PORT": "45679"}))
        # Framework inference and generated-file rules must survive future edits.
        config = json.loads((checkout / "turbo.json").read_text())
        assert config["tasks"]["@revv/web#sync"]["cache"] is False
        assert "REVV_BUILD_RUNTIME" in config["globalEnv"]
        assert "dist/**" in config["tasks"]["build"]["outputs"]
        print("Cache hashes verified: stable inputs, commit, root config, shared types, server types, runtime pin, and frontend environment")


if __name__ == "__main__":
    main()
