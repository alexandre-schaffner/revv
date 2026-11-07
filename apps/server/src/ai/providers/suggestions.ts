// PR-aware chat starter prompts for the right-panel empty state: a `promptOnce`
// turn, deliberately outside the chat pipeline. No MCP servers are attached,
// and the session id is never surfaced, persisted, or resumed into, so these
// throwaway turns can't appear in any history the user can resume. (The ACP
// agent may still spool a session file to its own store; that orphan is
// unreachable from Revv.)
//
// On any failure we return {@link CHAT_SUGGESTION_FALLBACKS} so the UI always
// renders sensible defaults instead of going blank.

import { CHAT_SUGGESTION_COUNT, CHAT_SUGGESTION_FALLBACKS } from "@revv/shared";
import { Effect } from "effect";
import { debug, logError } from "../../logger";
import { DiffCacheService } from "../../services/DiffCache";
import { PullRequestService } from "../../services/PullRequest";
import { WalkthroughService } from "../../services/Walkthrough";
import { type AgentLaunch, resolveAgentLaunch } from "../acp/agent-launch";
import { promptOnce } from "../acp/run-turn";

const SUGGESTIONS_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 80;
const MAX_FILES_LISTED = 30;

interface SuggestionsWalkthroughContext {
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

interface GenerateSuggestionsInput {
  readonly prTitle: string;
  readonly prBody: string | null;
  readonly changedFiles: ReadonlyArray<string>;
  readonly additions: number;
  readonly deletions: number;
  readonly walkthrough: SuggestionsWalkthroughContext | null;
  readonly launch: AgentLaunch;
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
 * Permissive on purpose: models wrap the JSON in fences or prose ("Here you
 * go:") or answer with a bullet list.
 */
function parsePrompts(raw: string): string[] | null {
  const text = raw.trim();
  if (text.length === 0) return null;

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

  const bulletLines = text
    .split("\n")
    .map((l) => l.replace(/^[\s-*0-9.)]+/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 200);
  if (bulletLines.length >= CHAT_SUGGESTION_COUNT) {
    const cleaned = sanitizePrompts(bulletLines.slice(0, CHAT_SUGGESTION_COUNT));
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
    if (out.length === CHAT_SUGGESTION_COUNT) break;
  }
  return out;
}

async function generateViaAcp(input: GenerateSuggestionsInput): Promise<string[]> {
  const collected = await promptOnce({
    label: "suggestions-acp",
    launch: input.launch,
    ceilingMs: SUGGESTIONS_TIMEOUT_MS,
    text: `${SYSTEM_PROMPT}\n\n---\n\n${buildUserMessage(input)}`,
  });
  const parsed = parsePrompts(collected);
  if (!parsed) {
    throw new Error(`acp agent returned unparseable output (len=${collected.length})`);
  }
  return parsed;
}

async function generateSuggestions(input: GenerateSuggestionsInput): Promise<string[]> {
  try {
    const result = await generateViaAcp(input);
    debug(
      "suggestions",
      `generated ${result.length} prompts via ${input.launch.agent}/${input.launch.model}`,
    );
    return result;
  } catch (err) {
    logError(
      "suggestions",
      `falling back to defaults:`,
      err instanceof Error ? err.message : String(err),
    );
    return [...CHAT_SUGGESTION_FALLBACKS];
  }
}

// Keyed on `${prId}:${headSha}:${agent}:${model}`, so any of those changing
// means a fresh model call; entries expire lazily on read. A reconstructible
// cache (invariant 1): it only saves re-spending tokens when the user reopens
// a PR within one server session.

interface SuggestionsCacheEntry {
  readonly suggestions: string[];
  readonly expiresAt: number;
}

const SUGGESTIONS_CACHE_TTL_MS = 60 * 60 * 1000;
const SUGGESTIONS_CACHE_MAX_ENTRIES = 256;
const suggestionsCache = new Map<string, SuggestionsCacheEntry>();

function readSuggestionsCache(key: string): string[] | null {
  const entry = suggestionsCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    suggestionsCache.delete(key);
    return null;
  }
  return entry.suggestions;
}

function writeSuggestionsCache(key: string, suggestions: string[]): void {
  if (suggestionsCache.size >= SUGGESTIONS_CACHE_MAX_ENTRIES) {
    const oldest = suggestionsCache.keys().next().value;
    if (oldest !== undefined) suggestionsCache.delete(oldest);
  }
  suggestionsCache.set(key, {
    suggestions,
    expiresAt: Date.now() + SUGGESTIONS_CACHE_TTL_MS,
  });
}

/**
 * Starter prompts for a PR, from its metadata, its cached diff (never fetched
 * here) and its complete walkthrough for the current head when there is one.
 */
export function suggestionsForPr(prId: string, accountId: string) {
  return Effect.gen(function* () {
    const launch = yield* resolveAgentLaunch("suggestions");
    if (!launch) return [...CHAT_SUGGESTION_FALLBACKS];

    const pr = yield* (yield* PullRequestService).getPr(prId, accountId);
    const key = `${prId}:${pr.headSha ?? "no-head"}:${launch.agent}:${launch.model}`;
    const cached = readSuggestionsCache(key);
    if (cached !== null) return cached;

    const walkthrough = pr.headSha
      ? yield* (yield* WalkthroughService).getCached(prId, pr.headSha)
      : null;
    const cachedFiles = yield* (yield* DiffCacheService).getCachedFiles(prId);

    const suggestions = yield* Effect.promise(() =>
      generateSuggestions({
        prTitle: pr.title,
        prBody: pr.body,
        changedFiles: (cachedFiles ?? []).map((f) => f.path),
        additions: pr.additions,
        deletions: pr.deletions,
        walkthrough: walkthrough
          ? {
              summary: walkthrough.summary,
              riskLevel: walkthrough.riskLevel,
              sentiment: walkthrough.sentiment ?? null,
              issues: walkthrough.issues.map((i) => ({
                severity: i.severity,
                title: i.title,
                description: i.description,
                filePath: i.filePath ?? null,
              })),
            }
          : null,
        launch,
      }),
    );

    writeSuggestionsCache(key, suggestions);
    return suggestions;
  });
}
