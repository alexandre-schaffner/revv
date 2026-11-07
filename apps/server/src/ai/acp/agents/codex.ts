import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampThinkingEffort, type ThinkingEffort } from "@revv/shared";
import { serverEnv } from "../../../config";
import { commandSucceeds, hostEnv, resolveCommandPath } from "../host";
import { staticModels } from "./static-models";
import { type AgentAdapter, type AgentAuthStatus, NOT_SIGNED_IN } from "./types";

const CODEX_REASONING_EFFORT: Partial<Record<ThinkingEffort, string>> = {
  ultra: "ultra",
  max: "max",
  "extra-high": "xhigh",
  high: "high",
  medium: "medium",
  low: "low",
};

const CODEX_DESKTOP_CLI_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
] as const;

/**
 * The Codex CLI bundled with the macOS desktop app. It shares the app's
 * ChatGPT login, but the app cannot always create its PATH alias (when it
 * lacks permission to write the shell setup), so it is the last fallback.
 */
export function resolveDesktopCodexBin(
  candidates: readonly string[] = CODEX_DESKTOP_CLI_CANDIDATES,
  isExecutable: (path: string) => boolean = (path) => {
    try {
      const stat = statSync(path);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  },
): string | null {
  return candidates.find(isExecutable) ?? null;
}

function bin(): string | null {
  const pinned = serverEnv.codexBin;
  return (
    (pinned && existsSync(pinned) ? pinned : null) ??
    resolveCommandPath("codex") ??
    resolveDesktopCodexBin()
  );
}

/** Codex's auth file, written by the CLI or the desktop app (`$CODEX_HOME`, else `~/.codex`). */
function loggedIn(): boolean {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const home = fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
  return existsSync(join(home, "auth.json"));
}

async function authStatus(): Promise<AgentAuthStatus> {
  const hasLogin = loggedIn();
  const hasApiKey = !!process.env.OPENAI_API_KEY?.trim();
  const verified = await commandSucceeds(bin() ?? "codex", ["login", "status"], hostEnv());
  if (hasLogin && hasApiKey) {
    return {
      authed: true,
      verified,
      authSource: "local-credentials",
      authLabel: verified ? "Codex login + OpenAI API key" : "Codex credentials configured",
      authWarning:
        "Both Codex login and OPENAI_API_KEY are present; provider precedence is owned by Codex.",
    };
  }
  if (hasLogin) {
    return verified
      ? {
          authed: true,
          verified: true,
          authSource: "local-credentials",
          authLabel: "Codex login",
          authWarning: null,
        }
      : {
          authed: false,
          verified: false,
          authSource: "local-credentials",
          authLabel: "Codex sign-in expired",
          authWarning:
            "Codex credential artifacts exist, but Codex login status does not confirm an active session. Sign in again with Codex.",
        };
  }
  if (hasApiKey) {
    return {
      authed: true,
      verified,
      authSource: "api-key",
      authLabel: verified ? "OpenAI API key verified" : "OpenAI API key configured",
      authWarning: verified
        ? null
        : "Revv found OPENAI_API_KEY, but Codex login status did not verify it without starting a generation.",
    };
  }
  if (verified) {
    return {
      authed: true,
      verified: true,
      authSource: "local-credentials",
      authLabel: "Codex login",
      authWarning: null,
    };
  }
  return NOT_SIGNED_IN;
}

export const codexAdapter: AgentAdapter = {
  route: ({ model, thinkingEffort }) => {
    // Clamped: effort and agent are stored independently, so a tier picked on
    // Claude Code outlives a switch here, and Codex rejects one it doesn't know.
    const tier = clampThinkingEffort("codex", thinkingEffort, model);
    const effort = tier ? CODEX_REASONING_EFFORT[tier] : undefined;
    // `@agentclientprotocol/codex-acp` starts Codex's App Server and reads
    // CODEX_CONFIG, rather than forwarding the legacy adapter's `-c` flags.
    if (!model && !effort) return { env: {} };
    return {
      env: {
        CODEX_CONFIG: JSON.stringify({
          ...(model ? { model } : {}),
          ...(effort ? { model_reasoning_effort: effort } : {}),
        }),
      },
    };
  },
  processEnv: (env) => env,
  resolveBin: bin,
  launchNeedsCli: false,
  hasCredentialsWithoutCli: loggedIn,
  authStatus,
  // The adapter advertises API-key auth first, but a ChatGPT subscription
  // session is the right default when available: requesting `api-key` makes a
  // signed-in desktop Codex fail before it can inspect that session.
  authMethod: (methods) => methods.find((method) => method.id === "chat-gpt")?.id ?? methods[0]?.id,
  listModels: async () => staticModels("codex"),
};
