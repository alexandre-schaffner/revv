// ── suggestions ────────────────────────────────────────────────────────────
//
// One-shot, no-tools, no-persistence provider for PR-aware chat starter
// prompts (rendered in the right-panel empty-state). Deliberately bypasses
// the chat/walkthrough pipelines:
//
//   • No MCP tools — the model just reads the inlined PR metadata and writes
//     back JSON. Spawning the review-context server and waiting for a tool
//     round-trip would defeat the "cheap, sub-2s" goal.
//   • No session persistence — these turns must never land in the chat
//     JSONL on disk, the opencode session store, or any history the user can
//     resume into. The suggestions are stateless ephemeral UI hints.
//   • Single turn, capped output — enforced by SDK flags (Claude) and by
//     parsing only the first `text` part out of the response (opencode).
//
// On any failure (CLI missing, model error, JSON parse failure, timeout) we
// return {@link FALLBACK_PROMPTS} so the UI always renders three sensible
// defaults instead of going blank. This is the same array the right panel
// historically hardcoded — keeping it server-side means the client doesn't
// need to know about the fallback policy.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AiAgent } from "@revv/shared";
import { debug, logError } from "../../logger";
import type { OpencodeClient, OpencodeEndpoint } from "../../services/OpencodeSupervisor";
import { parseOpencodeModel } from "../agent-stream";
import { resolveCliBin } from "./cli-agent";

export const FALLBACK_PROMPTS: readonly string[] = [
  "What's the riskiest change here?",
  "Summarize the security implications",
  "Suggest a test plan",
];

const SUGGESTIONS_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 80;
const MAX_FILES_LISTED = 30;

export interface OpencodeSuggestionsDeps {
  readonly ensureDaemon: () => Promise<OpencodeEndpoint>;
  readonly client: () => Promise<OpencodeClient | null>;
}

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
  readonly agent: AiAgent;
  readonly model: string;
  /** Required when `agent === 'opencode'`; ignored otherwise. */
  readonly opencodeDeps?: OpencodeSuggestionsDeps;
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

// ── Claude branch ────────────────────────────────────────────────────────────

async function generateViaClaude(input: GenerateSuggestionsInput): Promise<string[]> {
  const userMessage = buildUserMessage(input);
  const pinned = resolveCliBin("claude");
  const pathOption = pinned !== "claude" ? { pathToClaudeCodeExecutable: pinned } : {};

  const q = query({
    prompt: userMessage,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      // No tools: the model just reads the user message and writes
      // back JSON. No MCP servers, no file access, no shell.
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "default",
      // Critical: never write a session JSONL for these throwaway turns.
      persistSession: false,
      model: input.model,
      ...pathOption,
    },
  });

  let collected = "";
  for await (const message of q) {
    if (
      (message as { type?: string }).type === "assistant" &&
      (message as { message?: { content?: unknown } }).message
    ) {
      const content = (message as { message: { content: unknown } }).message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as { type?: string }).type === "text" &&
            typeof (block as { text?: string }).text === "string"
          ) {
            collected += (block as { text: string }).text;
          }
        }
      }
    }
  }

  const parsed = parsePrompts(collected);
  if (!parsed) {
    throw new Error(`claude returned unparseable output (len=${collected.length})`);
  }
  return parsed;
}

// ── Opencode branch ──────────────────────────────────────────────────────────

async function generateViaOpencode(
  input: GenerateSuggestionsInput,
  deps: OpencodeSuggestionsDeps,
): Promise<string[]> {
  await deps.ensureDaemon();
  const client = await deps.client();
  if (!client) {
    throw new Error("OpencodeSupervisor reports daemon-running but no client available");
  }

  const userMessage = buildUserMessage(input);
  const wireModel = parseOpencodeModel(input.model);

  // Create an ephemeral session. No MCP servers are attached, so the
  // daemon has only its built-in tools — and we don't allow any
  // tools-use round trips because we never re-prompt after the first turn.
  const created = await client.session.create(
    { title: `revv-suggestions-${Date.now()}` },
    { throwOnError: true },
  );
  const sessionId = created.data.id;

  try {
    const promptResult = await client.session.prompt(
      {
        sessionID: sessionId,
        parts: [{ type: "text", text: userMessage }],
        system: SYSTEM_PROMPT,
        ...(wireModel !== undefined ? { model: wireModel } : {}),
      },
      { throwOnError: true },
    );

    const response = promptResult.data;
    const errObj = response.info.error;
    if (errObj) {
      throw new Error(`opencode agent error: ${JSON.stringify(errObj).slice(0, 200)}`);
    }

    // Walk parts in declaration order, concat all text whose messageID
    // matches the assistant message we just got back. (Same filter pattern
    // chat-opencode uses to drop user-message echoes.)
    const assistantMessageId = response.info.id;
    let collected = "";
    for (const part of response.parts) {
      if (
        part.type === "text" &&
        (part as { messageID?: string }).messageID === assistantMessageId
      ) {
        collected += (part as { text?: string }).text ?? "";
      }
    }

    const parsed = parsePrompts(collected);
    if (!parsed) {
      throw new Error(`opencode returned unparseable output (len=${collected.length})`);
    }
    return parsed;
  } finally {
    // Best-effort cleanup of the throwaway session so the daemon doesn't
    // accumulate stale state across PR opens.
    try {
      await client.session.delete({ sessionID: sessionId });
    } catch {
      /* ignore */
    }
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function generateSuggestions(input: GenerateSuggestionsInput): Promise<string[]> {
  try {
    const work =
      input.agent === "claude"
        ? generateViaClaude(input)
        : (() => {
            if (!input.opencodeDeps) {
              throw new Error("generateSuggestions: opencodeDeps required when agent='opencode'");
            }
            return generateViaOpencode(input, input.opencodeDeps);
          })();
    const result = await withTimeout(work, SUGGESTIONS_TIMEOUT_MS, `suggestions:${input.agent}`);
    debug("suggestions", `generated ${result.length} prompts via ${input.agent}/${input.model}`);
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
