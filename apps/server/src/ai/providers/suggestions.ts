// ── suggestions ────────────────────────────────────────────────────────────
//
// One-shot, no-tools provider for PR-aware chat starter prompts (rendered in
// the right-panel empty-state). Runs over the same ACP transport as chat /
// walkthrough / recap (see ai/acp/presets.ts) — the single transport that
// replaced the bespoke claude / opencode / codex drivers — but deliberately
// bypasses the chat pipeline:
//
//   • No MCP tools — the agent gets a fresh ACP session with NO MCP servers
//     attached, so it has only its built-in tools (which the prompt tells it
//     not to use). It just reads the inlined PR metadata and writes back JSON.
//   • Ephemeral — the session id is never surfaced, persisted, or resumed into,
//     so these throwaway turns can't appear in any history the user can resume.
//     (The ACP agent may still spool a session file to its own store; that
//     orphan is unreachable from Revv — an accepted change vs. the SDK path's
//     `persistSession:false`.)
//   • Single turn, capped output — we issue one prompt, collect the agent's
//     text deltas, and parse the first JSON object out of them.
//
// On any failure (agent missing, model error, JSON parse failure, timeout) we
// return {@link FALLBACK_PROMPTS} so the UI always renders three sensible
// defaults instead of going blank. This is the same array the right panel
// historically hardcoded — keeping it server-side means the client doesn't
// need to know about the fallback policy.

import type { AcpAgentId, ContextWindow, ThinkingEffort } from "@revv/shared";
import { debug, logError } from "../../logger";
import { getAcpConnection } from "../acp/acp-connection";
import { decodeAcpSessionUpdate, makeAcpDecodeState, withAgentTurn } from "../agent-stream";

export const FALLBACK_PROMPTS: readonly string[] = [
  "What's the riskiest change here?",
  "Summarize the security implications",
  "Suggest a test plan",
];

const SUGGESTIONS_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 80;
const MAX_FILES_LISTED = 30;

/**
 * Subset of the completed walkthrough we feed into the suggestions prompt.
 * Optional — when the PR has no completed walkthrough yet, we fall back to
 * PR metadata only. When present, the model can ground prompts in what the
 * review agent already noticed (the riskiest file, a specific issue, a
 * sentiment) instead of generic "review the change" phrasing.
 */
export interface SuggestionsWalkthroughContext {
  readonly summary: string;
  readonly riskLevel: string;
  readonly sentiment: string | null;
  readonly issues: ReadonlyArray<{
    readonly severity: string;
    readonly title: string;
    readonly description: string;
    readonly filePath: string | null;
  }>;
}

export interface GenerateSuggestionsInput {
  readonly prTitle: string;
  readonly prBody: string | null;
  readonly changedFiles: ReadonlyArray<string>;
  readonly additions: number;
  readonly deletions: number;
  readonly walkthrough: SuggestionsWalkthroughContext | null;
  /** Resolved ACP registry agent id that produces the suggestions. */
  readonly acpAgentId: AcpAgentId;
  /** Working directory the ACP connection is pooled under (server cwd is fine — no tools run). */
  readonly cwd: string;
  readonly model: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  readonly contextWindow?: ContextWindow | undefined;
}

const SYSTEM_PROMPT = `You are helping a code reviewer skim a pull request. \
Given the PR metadata and (when present) the AI walkthrough below, generate \
exactly 3 short prompts the reviewer would find most useful to ask an AI \
assistant about THIS specific PR.

Rules:
- Each prompt must be 12 words or fewer.
- Reference concrete details — file names, the walkthrough's risk level, a \
specific issue surfaced by the walkthrough — when possible.
- Phrase as a question or instruction the reviewer would actually type.
- No greetings, no preamble, no explanations.

Return JSON only, exactly this shape: {"prompts": ["…", "…", "…"]}`;

function buildUserMessage(input: GenerateSuggestionsInput): string {
  const body = (input.prBody ?? "").trim();
  const truncatedBody = body.length > 600 ? `${body.slice(0, 600)}…` : body;
  const files = input.changedFiles.slice(0, MAX_FILES_LISTED);
  const moreFiles =
    input.changedFiles.length > MAX_FILES_LISTED
      ? `\n…and ${input.changedFiles.length - MAX_FILES_LISTED} more`
      : "";

  // Walkthrough context (when present) is the highest-signal input — the
  // review agent has already digested the diff and called out a risk
  // level, an overall sentiment, and zero or more issues. Including this
  // up front lets the suggestions model anchor its prompts to what the
  // reviewer would actually want to dig into.
  let walkthroughSection: string | null = null;
  if (input.walkthrough) {
    const w = input.walkthrough;
    const summary = w.summary.trim();
    const truncatedSummary = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
    const sentiment = (w.sentiment ?? "").trim();
    const truncatedSentiment = sentiment.length > 300 ? `${sentiment.slice(0, 300)}…` : sentiment;
    const topIssues = w.issues.slice(0, 5).map((i) => {
      const desc = i.description.trim();
      const truncDesc = desc.length > 160 ? `${desc.slice(0, 160)}…` : desc;
      const where = i.filePath ? ` (${i.filePath})` : "";
      return `- [${i.severity}] ${i.title}${where}: ${truncDesc}`;
    });
    walkthroughSection = [
      `AI walkthrough:`,
      `- Risk: ${w.riskLevel}`,
      truncatedSummary.length > 0 ? `- Summary: ${truncatedSummary}` : null,
      truncatedSentiment.length > 0 ? `- Sentiment: ${truncatedSentiment}` : null,
      topIssues.length > 0 ? `Issues flagged:\n${topIssues.join("\n")}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join("\n");
  }

  return [
    `Title: ${input.prTitle}`,
    `Stats: +${input.additions} / -${input.deletions} across ${input.changedFiles.length} file${input.changedFiles.length === 1 ? "" : "s"}`,
    truncatedBody.length > 0 ? `Body:\n${truncatedBody}` : null,
    files.length > 0
      ? `Changed files:\n${files.map((f) => `- ${f}`).join("\n")}${moreFiles}`
      : null,
    walkthroughSection,
  ]
    .filter((s): s is string => s !== null)
    .join("\n\n");
}

/**
 * Extract three short, sanitized prompts from raw model output. Accepts both
 * the strict JSON shape we ask for and a few permissive fallbacks (raw JSON
 * embedded in prose, bullet lists) so a model that prepends "Here you go:"
 * doesn't blow the whole feature up.
 */
function parsePrompts(raw: string): string[] | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // 1. Strict JSON, possibly wrapped in ```json fences.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    const promptsRaw = (parsed as { prompts?: unknown })?.prompts;
    if (Array.isArray(promptsRaw)) {
      const cleaned = sanitizePrompts(promptsRaw);
      if (cleaned.length > 0) return cleaned;
    }
  } catch {
    /* fall through to permissive parsing */
  }

  // 2. Find the first {…} that contains "prompts".
  const objMatch = text.match(/\{[\s\S]*?"prompts"[\s\S]*?\]\s*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]) as { prompts?: unknown };
      if (Array.isArray(parsed.prompts)) {
        const cleaned = sanitizePrompts(parsed.prompts);
        if (cleaned.length > 0) return cleaned;
      }
    } catch {
      /* fall through */
    }
  }

  // 3. Bullet / numbered list fallback (e.g. "- prompt one\n- prompt two").
  const bulletLines = text
    .split("\n")
    .map((l) => l.replace(/^[\s-*0-9.)]+/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 200);
  if (bulletLines.length >= 3) {
    const cleaned = sanitizePrompts(bulletLines.slice(0, 3));
    if (cleaned.length > 0) return cleaned;
  }

  return null;
}

function sanitizePrompts(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim().replace(/^["'\s]+|["'\s]+$/g, "");
    if (trimmed.length === 0) continue;
    const capped =
      trimmed.length > MAX_PROMPT_LENGTH ? `${trimmed.slice(0, MAX_PROMPT_LENGTH - 1)}…` : trimmed;
    out.push(capped);
    if (out.length === 3) break;
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── ACP one-shot ─────────────────────────────────────────────────────────────

async function generateViaAcp(input: GenerateSuggestionsInput): Promise<string[]> {
  const userMessage = buildUserMessage(input);
  const h = await getAcpConnection(input.cwd, input.acpAgentId, {
    model: input.model,
    thinkingEffort: input.thinkingEffort,
    contextWindow: input.contextWindow,
  });

  let sessionId: string | null = null;
  let collected = "";

  try {
    await withAgentTurn<void>({
      hardTimeoutMs: SUGGESTIONS_TIMEOUT_MS,
      jobStarted: async () => {
        h.jobStarted();
      },
      jobEnded: async () => {
        h.jobEnded();
      },
      debugLabel: "suggestions-acp",
      abortSession: async () => {
        if (sessionId) await h.cancel(sessionId);
      },
      run: async () => {
        // Fresh session, NO MCP servers — the agent has only its built-in
        // tools and the prompt tells it to just read + answer in JSON.
        const created = await h.newSession([]);
        sessionId = created.sessionId;
        const decodeState = makeAcpDecodeState();
        h.setListener(sessionId, (update) => {
          for (const ev of decodeAcpSessionUpdate(update, decodeState)) {
            if (ev.kind === "text-delta") collected += ev.data;
          }
        });
        // ACP has no separate system-prompt channel — prepend it (codex-style).
        const promptText = `${SYSTEM_PROMPT}\n\n---\n\n${userMessage}`;
        await h.prompt(sessionId, [{ type: "text", text: promptText }]);
      },
    });
  } finally {
    if (sessionId) h.setListener(sessionId, null);
  }

  const parsed = parsePrompts(collected);
  if (!parsed) {
    throw new Error(`acp agent returned unparseable output (len=${collected.length})`);
  }
  return parsed;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function generateSuggestions(input: GenerateSuggestionsInput): Promise<string[]> {
  try {
    const result = await withTimeout(
      generateViaAcp(input),
      SUGGESTIONS_TIMEOUT_MS,
      `suggestions:${input.acpAgentId}`,
    );
    debug(
      "suggestions",
      `generated ${result.length} prompts via ${input.acpAgentId}/${input.model}`,
    );
    return result;
  } catch (err) {
    // Any failure path — CLI missing, model error, JSON parse fail,
    // timeout, daemon refuse — collapses to the static fallback. The
    // UI never sees an empty list.
    logError(
      "suggestions",
      `falling back to defaults:`,
      err instanceof Error ? err.message : String(err),
    );
    return [...FALLBACK_PROMPTS];
  }
}
