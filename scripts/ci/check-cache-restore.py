"""Verify generated files and build bytes survive a clean task-cache restore."""
import hashlib
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUTS = ["apps/web/build", "apps/web/.svelte-kit", "apps/server/dist", "apps/collector/dist"]
SAMPLES = ["apps/web/build/index.html", "apps/server/dist/index.js", "apps/collector/dist/index.js"]


def main():
    # Populate this exact task key before moving its outputs aside.
    subprocess.run(["bun", "run", "build"], cwd=ROOT, check=True)
    expected = {name: hashlib.sha256((ROOT / name).read_bytes()).digest() for name in SAMPLES}
    with tempfile.TemporaryDirectory(prefix="revv-outputs-") as temp:
        backup = pathlib.Path(temp)
        for index, name in enumerate(OUTPUTS):
            shutil.move(ROOT / name, backup / str(index))
        try:
            # Cached typechecking still needs SvelteKit's uncached sync for Knip.
            for command in ["typecheck", "knip", "build"]:
                subprocess.run(["bun", "run", command], cwd=ROOT, check=True)
            for name, digest in expected.items():
                if hashlib.sha256((ROOT / name).read_bytes()).digest() != digest:
                    raise ValueError(f"Restored build differs: {name}")
            if not (ROOT / "apps/web/.svelte-kit/tsconfig.json").is_file():
                raise ValueError("Generated SvelteKit config was not restored")
        except BaseException:
            for index, name in enumerate(OUTPUTS):
                destination = ROOT / name
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.move(backup / str(index), destination)
            raise
    print("Clean output restore verified with typecheck, Knip, and identical build bytes")


if __name__ == "__main__":
    main()
