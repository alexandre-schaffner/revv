import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "revv-tests-"));
try {
  for (const cwd of ["apps/server", "apps/collector", "apps/web", "scripts/performance"]) {
    const result = spawnSync(process.execPath, ["--no-env-file", "test", "--timeout", "30000"], {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        REVV_DB_PATH: join(sandbox, "test.db"),
        REVV_CLONE_DIR: join(sandbox, "repos"),
        XDG_CONFIG_HOME: join(sandbox, "config"),
        XDG_DATA_HOME: join(sandbox, "data"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Revv Test",
        GIT_AUTHOR_EMAIL: "revv-test@example.invalid",
        GIT_COMMITTER_NAME: "Revv Test",
        GIT_COMMITTER_EMAIL: "revv-test@example.invalid",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
