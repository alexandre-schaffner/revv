import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandSucceeds, hostEnv, resolveCommandPath } from "../host";
import { staticModels } from "./static-models";
import { type AgentAdapter, type AgentAuthStatus, firstAuthMethod, NOT_SIGNED_IN } from "./types";

/**
 * `cursor-agent login` persists a session token; the file location isn't part
 * of Cursor's public contract, so these are the ones seen across versions
 * (XDG and the legacy `~/.cursor`). Re-verify against a real install if Cursor
 * moves it: a miss only shows "Sign in" for an already-authed Cursor.
 */
function credentialFileExists(): boolean {
  const home = homedir();
  return [
    join(home, ".config", "cursor-agent", "credentials.json"),
    join(home, ".config", "cursor-agent", "auth.json"),
    join(home, ".local", "share", "cursor-agent", "credentials.json"),
    join(home, ".local", "share", "cursor-agent", "auth.json"),
    join(home, ".cursor", "credentials.json"),
    join(home, ".cursor", "auth.json"),
  ].some((p) => existsSync(p));
}

function authStatus(): AgentAuthStatus {
  const verified = commandSucceeds(
    resolveCommandPath("cursor-agent") ?? "cursor-agent",
    ["status"],
    hostEnv(),
  );
  if (process.env.CURSOR_API_KEY?.trim()) {
    return {
      authed: true,
      verified,
      authSource: "api-key",
      authLabel: verified ? "Cursor API key verified" : "Cursor API key configured",
      authWarning: verified
        ? null
        : "Revv found CURSOR_API_KEY, but Cursor status did not verify it without starting a generation.",
    };
  }
  if (credentialFileExists()) {
    return verified
      ? {
          authed: true,
          verified: true,
          authSource: "local-credentials",
          authLabel: "Cursor login",
          authWarning: null,
        }
      : {
          authed: false,
          verified: false,
          authSource: "local-credentials",
          authLabel: "Cursor sign-in expired",
          authWarning:
            "Cursor credential artifacts exist, but Cursor status does not confirm an active session. Sign in again with Cursor.",
        };
  }
  if (verified) {
    return {
      authed: true,
      verified: true,
      authSource: "local-credentials",
      authLabel: "Cursor login",
      authWarning: null,
    };
  }
  return NOT_SIGNED_IN;
}

export const cursorAdapter: AgentAdapter = {
  // `cursor-agent-acp` neither forwards a model flag nor advertises a `model`
  // config option: Cursor runs its own configured model.
  route: () => ({ env: {} }),
  processEnv: (env) => env,
  resolveBin: () => resolveCommandPath("cursor-agent"),
  // `cursor-agent-acp` shells out to `cursor-agent`.
  launchNeedsCli: true,
  hasCredentialsWithoutCli: () => false,
  authStatus,
  authMethod: firstAuthMethod,
  listModels: async () => staticModels("cursor"),
};
