// ── Dynamic model listing ─────────────────────────────────────────────────────
//
// The model picker's catalog per ACP agent. Static catalogs come from the
// shared registry; opencode's is read live from the installed CLI, whose
// interface differs between opencode 1 and 2.

import { type AcpAgentId, getAgentCapabilities } from "@revv/shared";
import { debug, logError } from "../../logger";
import { resolveCliBin, resolveUserPath } from "./cli-agent";

export type CliModelOption = { label: string; value: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One opencode model row (`/api/model` or `models --verbose`) as a picker option. */
function opencodeModelOption(row: unknown): CliModelOption | undefined {
  if (!isRecord(row)) return undefined;
  const { id, providerID, name, enabled } = row;
  if (typeof id !== "string" || typeof providerID !== "string" || enabled === false) {
    return undefined;
  }
  const value = `${providerID}/${id}`;
  return { label: typeof name === "string" && name ? name : value, value };
}

/** Values are ordered so each provider's models stay together (the API orders by release). */
function toModelOptions(rows: readonly unknown[]): CliModelOption[] {
  return rows
    .map(opencodeModelOption)
    .filter((option) => option !== undefined)
    .sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Parse opencode 2's `GET /api/model` response (via `opencode api`) into picker
 * options. Values are `provider/model` — the same ids opencode's ACP `model`
 * config option takes. Disabled models are dropped.
 */
export function parseOpencodeModelList(text: string): CliModelOption[] {
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) && Array.isArray(parsed.data) ? toModelOptions(parsed.data) : [];
}

/**
 * Parse opencode 1's `opencode models --verbose`: each model is a
 * `provider/model` line followed by a pretty-printed JSON blob of its metadata
 * (the same row fields `/api/model` serves).
 */
export function parseOpencodeVerboseModels(text: string): CliModelOption[] {
  const rows: unknown[] = [];
  let blob = "";
  let depth = 0;
  for (const line of text.split("\n")) {
    if (depth === 0 && !line.trimStart().startsWith("{")) continue;
    blob += `${line}\n`;
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth > 0) continue;
    try {
      rows.push(JSON.parse(blob));
    } catch {
      /* not a metadata blob */
    }
    blob = "";
    depth = 0;
  }
  return toModelOptions(rows);
}

// opencode 2 serves its catalog from a shared background service, which
// `opencode api` starts on demand. It is opencode's per-user daemon, shared
// with the user's own opencode sessions, so Revv never stops it (unlike the
// agent daemons it owns). A service that is still starting answers
// with an empty snapshot (the catalog "may precede initial plugin settlement"),
// so an empty list is retried briefly before it is believed. The whole listing
// shares one deadline, well below the two minutes the CLI itself waits for a
// service that won't start, since the settings route awaits it.
const OPENCODE_MODEL_LIST_BUDGET_MS = 20_000;
const OPENCODE_MODEL_LIST_RETRY_MS = 500;

type CliRun = { readonly ok: true; readonly text: string } | { readonly ok: false };

async function runOpencode(bin: string, args: string[], deadline: number): Promise<CliRun> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { ok: false };
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    // Inherit the login-shell PATH so the spawn can resolve a bare binary
    // name even when the server process inherits a sanitized PATH.
    env: { ...process.env, PATH: resolveUserPath() },
  });
  const [text, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode === 0) return { ok: true, text };
  debug(
    "listCliModels",
    `opencode ${args.join(" ")} exited ${proc.exitCode ?? "with signal"}`,
    stderrText.slice(0, 500),
  );
  return { ok: false };
}

async function listOpencodeModels(bin: string): Promise<CliModelOption[]> {
  const deadline = Date.now() + OPENCODE_MODEL_LIST_BUDGET_MS;
  for (;;) {
    const res = await runOpencode(bin, ["api", "GET", "/api/model"], deadline);
    // opencode 1 has no `api` subcommand; it lists its catalog directly.
    if (!res.ok) break;
    const models = parseOpencodeModelList(res.text);
    if (models.length > 0) return models;
    if (Date.now() + OPENCODE_MODEL_LIST_RETRY_MS >= deadline) {
      logError("listCliModels", "opencode reported no models");
      return [];
    }
    await Bun.sleep(OPENCODE_MODEL_LIST_RETRY_MS);
  }
  const legacy = await runOpencode(bin, ["models", "--verbose"], deadline);
  if (!legacy.ok) {
    logError("listCliModels", "could not list opencode models");
    return [];
  }
  return parseOpencodeVerboseModels(legacy.text);
}

/**
 * List models available to the selected ACP agent. Agents with a static
 * catalog (claude-code, codex, cursor) return it straight from the shared
 * registry; opencode is the only dynamic catalog, read from its server API
 * (`opencode api GET /api/model`, opencode 2) or `opencode models --verbose`
 * (opencode 1).
 */
export async function listCliModels(agent: AcpAgentId): Promise<CliModelOption[]> {
  // Static catalogs come straight from the shared ACP registry — the single
  // source of truth — so there's no second copy to keep in sync.
  const caps = getAgentCapabilities(agent);
  if (caps.models !== "dynamic") {
    return caps.models.map((m) => ({ label: m.label, value: m.value }));
  }

  const opencodeBin = resolveCliBin("opencode");
  debug("listCliModels", "opencode binary:", opencodeBin);
  try {
    return await listOpencodeModels(opencodeBin);
  } catch (e) {
    logError(
      "listCliModels",
      "failed to list opencode models",
      e instanceof Error ? e.message : String(e),
    );
    // Fallback: empty list (frontend will show empty state)
    return [];
  }
}
