"""Boot the server compiled into a built Revv.app and check it is the expected build.

    python3 scripts/tests/bundled-server.py <path/to/Revv.app> <commit-sha>

Runs in an isolated HOME, database, and port, so it never touches a real install.
"""
import json
import pathlib
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

app, commit = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2]
server = app / "Contents/MacOS/revv-server"
if not server.is_file():
    raise SystemExit(f"{server} is missing")
journal = json.loads((pathlib.Path(__file__).resolve().parents[2] / "apps/server/src/db/migrations/meta/_journal.json").read_text())

with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]

with tempfile.TemporaryDirectory() as root:
    home = pathlib.Path(root)
    database = home / "revv.db"
    env = {
        "HOME": root,
        "PATH": "/usr/bin:/bin",
        "PORT": str(port),
        "REVV_CHANNEL": "dev",
        "REVV_DB_PATH": str(database),
        "REVV_CLONE_DIR": str(home / "repos"),
    }
    log = (home / "server.log").open("w+")
    child = subprocess.Popen([str(server)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 60
        health = None
        while time.monotonic() < deadline and child.poll() is None:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
                    health = json.load(response)
                    break
            except OSError:
                time.sleep(0.25)
        if health is None:
            log.seek(0)
            raise SystemExit(f"Bundled server never became healthy:\n{log.read()}")
        if health.get("commit") != commit:
            raise SystemExit(f"Bundled server reports commit {health.get('commit')!r}, expected {commit}")
        with sqlite3.connect(database) as db:
            applied = db.execute("SELECT COUNT(*) FROM __drizzle_migrations").fetchone()[0]
        if applied != len(journal["entries"]):
            raise SystemExit(f"Applied {applied} of {len(journal['entries'])} migrations")
        print(f"Bundled server healthy at {commit[:7]} with {applied} migrations")
    finally:
        child.terminate()
        child.wait(timeout=15)
