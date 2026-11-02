"""Resolve an exact, successful main-push CI run before any release work."""
import json
import os
import re
import subprocess


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def validate_run(run, repo, workflow_id, sha=None):
    if not (
        run["repository"]["full_name"] == repo
        and run["head_repository"]["full_name"] == repo
        and run["workflow_id"] == workflow_id
        and run["event"] == "push"
        and run["head_branch"] == "main"
        and run["status"] == "completed"
        and run["conclusion"] == "success"
        and re.fullmatch(r"[a-f0-9]{40}", run["head_sha"])
        and (sha is None or run["head_sha"] == sha)
    ):
        raise ValueError("Release requires successful push CI from this repository's main branch")
    return run["head_sha"]


def main():
    repo = os.environ["GH_REPO"]
    workflow_id = api(f"repos/{repo}/actions/workflows/ci.yml")["id"]
    tag = os.environ.get("RECOVERY_TAG", "")
    sha = None
    if tag:
        if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
            raise ValueError("Recovery requires a stable version tag")
        release = api(f"repos/{repo}/releases/tags/{tag}")
        if not release["draft"]:
            raise ValueError("Recovery can only replace assets on a draft release")
        obj = api(f"repos/{repo}/git/ref/tags/{tag}")["object"]
        while obj["type"] == "tag":
            obj = api(f"repos/{repo}/git/tags/{obj['sha']}")["object"]
        if obj["type"] != "commit":
            raise ValueError("Release tag must resolve to a commit")
        sha = obj["sha"]
    run_id = os.environ.get("CI_RUN_ID", "")
    if run_id:
        if not run_id.isdecimal():
            raise ValueError("Invalid CI run ID")
        run = api(f"repos/{repo}/actions/runs/{run_id}")
    else:
        sha = sha or api(f"repos/{repo}/commits/main")["sha"]
        runs = api(f"repos/{repo}/actions/workflows/ci.yml/runs?head_sha={sha}&status=success&event=push&per_page=100")["workflow_runs"]
        run = next((r for r in runs if r["head_branch"] == "main"), None)
        if run is None:
            raise ValueError("No successful main CI for this SHA; rerun its original CI run first")
    sha = validate_run(run, repo, workflow_id, sha)
    comparison = api(f"repos/{repo}/compare/{sha}...main")
    if comparison["status"] not in ("ahead", "identical"):
        raise ValueError("Tested SHA is no longer on main")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"sha={sha}\nci_run_id={run['id']}\n")


if __name__ == "__main__":
    main()
