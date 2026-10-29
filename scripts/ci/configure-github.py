"""Apply the repository-side CI/CD protections without replacing unrelated policy."""
import argparse
import json
import pathlib
import subprocess


def api(repo, path, method="GET", body=None):
    args = ["gh", "api", f"repos/{repo}/{path}", "--method", method]
    if body is not None:
        args += ["--input", "-"]
    result = subprocess.check_output(args, input=json.dumps(body) if body is not None else None, text=True)
    return json.loads(result) if result.strip() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="alexandre-schaffner/revv")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--finalize-secret-migration", action="store_true")
    args = parser.parse_args()
    repo = args.repo
    if args.finalize_secret_migration:
        path = ".github/workflows/_build-tauri.yml"
        remote = subprocess.check_output(["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{path}?ref=main"], text=True)
        local = (pathlib.Path(__file__).resolve().parents[2] / path).read_text()
        if remote != local:
            raise RuntimeError("Merge this workflow into main before removing the legacy repository signing key")
        names = subprocess.check_output(["gh", "secret", "list", "--repo", repo, "--env", "release", "--json", "name"], text=True)
        if not any(secret["name"] == "TAURI_SIGNING_PRIVATE_KEY" for secret in json.loads(names)):
            raise RuntimeError("The release environment signing key is missing")
        subprocess.run(["gh", "secret", "delete", "TAURI_SIGNING_PRIVATE_KEY", "--repo", repo], check=True)
        print("Removed the legacy repository key. Signing now uses only the release environment.")
        return
    if not args.apply:
        print("Plan: enable Dependabot alerts and fixes; create a main-only release environment; require ci-ok and PRs on main; block force pushes and deletion.")
        return
    api(repo, "vulnerability-alerts", "PUT")
    api(repo, "automated-security-fixes", "PUT")
    api(repo, "environments/release", "PUT", {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}})
    policies = api(repo, "environments/release/deployment-branch-policies")["branch_policies"]
    if not any(p["name"] == "main" and p["type"] == "branch" for p in policies):
        api(repo, "environments/release/deployment-branch-policies", "POST", {"name": "main", "type": "branch"})
    branch = api(repo, "branches/main")
    if branch["protected"]:
        # An existing policy may be stronger. Never replace it with this baseline.
        protection = api(repo, "branches/main/protection")
        contexts = protection["required_status_checks"]["contexts"]
        if "ci-ok" not in contexts or not protection.get("required_pull_request_reviews"):
            raise RuntimeError("main already has different protection; reconcile its existing policy before changing it")
        print("main already requires ci-ok and PRs; preserved its existing protection.")
        return
    api(repo, "branches/main/protection", "PUT", {
        "required_status_checks": {"strict": True, "checks": [{"context": "ci-ok", "app_id": 15368}]},
        "enforce_admins": True,
        "required_pull_request_reviews": {"required_approving_review_count": 0},
        "restrictions": None,
        "allow_force_pushes": False,
        "allow_deletions": False,
        "required_conversation_resolution": True,
    })
    print("Dependabot enabled, release environment restricted to main, and main protected with ci-ok.")


if __name__ == "__main__":
    main()
