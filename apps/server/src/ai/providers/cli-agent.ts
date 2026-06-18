import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type AcpAgentId, getAgentCapabilities } from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_CACHE_TTL_MS } from "../../constants";

// ── CLI agent detection ──────────────────────────────────────────────────────
//
// Resolution chain, in order:
//
//   1. REVV_CLAUDE_BIN / REVV_OPENCODE_BIN — absolute paths baked into the
//      LaunchAgent at install time by `write_launch_agent_plist` in
//      scripts/lib/common.sh (which runs `command -v <tool>` with the
//      installer's shell PATH). Survives restricted LaunchAgent PATH.
//   2. `which <tool>` at runtime — covers `make dev` / dev shells where the
//      env var isn't in play and PATH is rich.
//
// No hardcoded dir list: if neither source finds the binary, treat it as
// not installed.
//
// Detection is cached per-agent with a short TTL (see CLI_CACHE_TTL_MS).

let cachedCliAuth: { result: boolean; expiresAt: number; agent: string } | null = null;

type CliAgent = "opencode" | "claude" | "codex";

function pinnedBin(agent: CliAgent): string {
  const pinned =
    agent === "claude"
      ? serverEnv.claudeBin
      : agent === "codex"
        ? serverEnv.codexBin
        : serverEnv.opencodeBin;
  return pinned && existsSync(pinned) ? pinned : "";
}

function isCliAgentAvailable(agent: CliAgent): boolean {
  if (pinnedBin(agent)) return true;
  try {
    const result = execSync(`which ${agent}`, { encoding: "utf-8", timeout: 3000 });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the CLI binary if we have one, else the bare name so
 * Bun.spawn falls back to PATH resolution. Callers should pass the result
 * directly as argv[0] of a spawn call.
 */
export function resolveCliBin(agent: CliAgent): string {
  return pinnedBin(agent) || agent;
}

/**
 * Bare `which <command>` probe — no env-pin, no cache. Used by onboarding to
 * detect agent CLIs that have no `REVV_*_BIN` pin (e.g. Cursor's `cursor-agent`),
 * where the pinned/cached `checkCliAvailability` path doesn't apply.
 */
export function isCommandOnPath(command: string): boolean {
  try {
    return execSync(`which ${command}`, { encoding: "utf-8", timeout: 3000 }).trim().length > 0;
  } catch {
    return false;
  }
}

export function checkCliAvailability(agent: CliAgent): boolean {
  if (cachedCliAuth && Date.now() < cachedCliAuth.expiresAt && cachedCliAuth.agent === agent) {
    return cachedCliAuth.result;
  }

  const available = isCliAgentAvailable(agent);
  cachedCliAuth = { result: available, expiresAt: Date.now() + CLI_CACHE_TTL_MS, agent };
  return available;
}

/**
 * Drop the cached availability result so the next `checkCliAvailability`
 * call hits the filesystem again. Called by the install-opencode flow
 * after a successful install — without this the TTL would mask the
 * newly-present binary until the cache naturally expired.
 */
export function invalidateCliAgentCache(): void {
  cachedCliAuth = null;
}

// ── Dynamic model listing ─────────────────────────────────────────────────────

export type CliModelOption = { label: string; value: string };

/**
 * List models available to the selected ACP agent. Agents with a static
 * catalog (claude-code, codex, cursor) return it straight from the shared
 * registry; opencode is the only dynamic catalog, probed by running
 * `opencode models --verbose` and parsing the output.
 */
export async function listCliModels(agent: AcpAgentId): Promise<CliModelOption[]> {
  // Static catalogs come straight from the shared ACP registry — the single
  // source of truth — so there's no second copy to keep in sync. Only opencode
  // has a dynamic catalog that must be probed at runtime.
  const caps = getAgentCapabilities(agent);
  if (caps.models !== "dynamic") {
    return caps.models.map((m) => ({ label: m.label, value: m.value }));
  }

  // opencode: run `opencode models --verbose` and parse interleaved output
  // Format: line with "provider/id", then JSON blob with model metadata, repeated
  try {
    const proc = Bun.spawn([resolveCliBin("opencode"), "models", "--verbose"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const models: CliModelOption[] = [];
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]?.trim();
      if (!line) {
        i++;
        continue;
      }

      // Check if this line looks like a model ID (e.g. "provider/model-id")
      if (!line.startsWith("{") && line.includes("/")) {
        const modelId = line;
        // Next non-empty content should be a JSON blob — collect until balanced braces
        let jsonStr = "";
        let depth = 0;
        i++;
        while (i < lines.length) {
          const jsonLine = lines[i] ?? "";
          jsonStr += `${jsonLine}\n`;
          for (const ch of jsonLine) {
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
          }
          i++;
          if (depth === 0 && jsonStr.trim().startsWith("{")) break;
        }
        try {
          const meta = JSON.parse(jsonStr.trim()) as { name?: string; providerID?: string };
          const label = meta.name ?? modelId;
          models.push({ label, value: modelId });
        } catch {
          models.push({ label: modelId, value: modelId });
        }
      } else {
        i++;
      }
    }
    return models;
  } catch {
    // Fallback: empty list (frontend will show empty state)
    return [];
  }
}
