import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
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

let cachedCliAuth: {
  result: boolean;
  expiresAt: number;
  agent: string;
} | null = null;

type CliAgent = "opencode" | "claude";

function pinnedBin(agent: CliAgent): string {
  const pinned =
    agent === "claude" ? serverEnv.claudeBin : serverEnv.opencodeBin;
  return pinned && existsSync(pinned) ? pinned : "";
}

function isCliAgentAvailable(agent: CliAgent): boolean {
  if (pinnedBin(agent)) return true;
  try {
    const result = execSync(`which ${agent}`, {
      encoding: "utf-8",
      timeout: 3000,
    });
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

export function checkCliAvailability(agent: CliAgent): boolean {
  if (
    cachedCliAuth &&
    Date.now() < cachedCliAuth.expiresAt &&
    cachedCliAuth.agent === agent
  ) {
    return cachedCliAuth.result;
  }

  const available = isCliAgentAvailable(agent);
  cachedCliAuth = {
    result: available,
    expiresAt: Date.now() + CLI_CACHE_TTL_MS,
    agent,
  };
  return available;
}

// ── Dynamic model listing ─────────────────────────────────────────────────────

export type CliModelOption = { label: string; value: string };

/**
 * List models available to the selected CLI agent.
 * For opencode: runs `opencode models --verbose` and parses output.
 * For claude: returns a hardcoded list (no offline model listing available).
 */
export async function listCliModels(
  agent: "opencode" | "claude",
): Promise<CliModelOption[]> {
  if (agent === "claude") {
    return [
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001" },
    ];
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
          const meta = JSON.parse(jsonStr.trim()) as {
            name?: string;
            providerID?: string;
          };
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
