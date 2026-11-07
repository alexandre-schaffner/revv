import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serverEnv } from "../../../config";
import { debug, logError } from "../../../logger";
import { resolveCommandPath } from "../host";
import { listOpencodeModels } from "./opencode-models";
import type { AgentAdapter } from "./types";

/**
 * Where opencode's installers (bun, the official script, Homebrew) put the
 * binary when neither the pin nor the login-shell PATH finds it: a
 * launchd-spawned server can miss them.
 */
function fallbackBin(): string | null {
  const home = homedir();
  const dirs = [
    join(home, ".bun", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = join(dir, "opencode");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Absent, or a broken symlink / half-finished install.
    }
  }
  return null;
}

function bin(): string | null {
  const pinned = serverEnv.opencodeBin;
  return (
    (pinned && existsSync(pinned) ? pinned : null) ??
    resolveCommandPath("opencode") ??
    fallbackBin()
  );
}

export const opencodeAdapter: AgentAdapter = {
  // `opencode acp` rejects a `--model` flag (exit 1, "ACP connection closed").
  // opencode 1 takes the model from an inline OPENCODE_CONFIG_CONTENT; opencode
  // 2 ignores that and seeds sessions from its own default, so the model also
  // goes per session through the `model` config option both advertise.
  route: ({ model }) =>
    model
      ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model }) }, sessionModel: model }
      : { env: {} },
  processEnv: (env) => env,
  resolveBin: bin,
  // The ACP launch is the opencode binary itself.
  launchNeedsCli: true,
  hasCredentialsWithoutCli: () => false,
  // A local engine: nothing to sign in to.
  authStatus: async () => ({
    authed: true,
    verified: true,
    authSource: "not-required",
    authLabel: "No sign-in required",
    authWarning: null,
  }),
  authMethod: (methods) => methods[0]?.id,
  listModels: async () => {
    const opencode = bin() ?? "opencode";
    debug("listModels", "opencode binary:", opencode);
    try {
      return await listOpencodeModels(opencode);
    } catch (e) {
      logError(
        "listModels",
        "failed to list opencode models",
        e instanceof Error ? e.message : String(e),
      );
      return [];
    }
  },
};
