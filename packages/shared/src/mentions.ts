// ── Composer mention/command grammar ──────────────────────────────────────
//
// Single source of truth for the `@path` / `/command` autocomplete grammar
// shared by the web composer and the server's prompt builder. Keeping both
// regexes co-located here prevents the two sides from drifting on what
// counts as a mention token (the bug a split client/server parser invites).
//
// Two distinct operations, one grammar:
//   - `detectMentionTrigger` — what is the user actively typing at the caret?
//     (client composer, anchored at end-of-input)
//   - `extractMentionTokens` — which `@path`s did the finished message name?
//     (server, scans the whole message)

/** The active autocomplete trigger under the caret. */
export type MentionTrigger =
  | { readonly kind: "slash"; readonly start: number; readonly query: string }
  | { readonly kind: "mention"; readonly start: number; readonly query: string };

// A marker (`/` or `@`) at start-of-input or after whitespace, then the token
// chars up to the caret. Anchored at end (`$`) so it only matches what's being
// typed right now.
const TRIGGER_AT_CARET_RE = /(^|\s)([/@])([^\s]*)$/;

// Every `@token` in a message. Excludes backticks so a backticked `@path`
// example (e.g. in a system prompt) is not treated as a real mention.
const MENTION_TOKEN_RE = /(^|\s)@([^\s`]+)/g;

/**
 * Detect the active autocomplete trigger in the text before the caret. Slash
 * commands only trigger at the very start of the input; `@`-mentions trigger
 * anywhere. Returns `null` when the caret is not in a trigger token.
 */
export function detectMentionTrigger(textBeforeCaret: string): MentionTrigger | null {
  const match = TRIGGER_AT_CARET_RE.exec(textBeforeCaret);
  if (!match || match.index === undefined) return null;
  const prefix = match[1] ?? "";
  const marker = match[2];
  const query = match[3] ?? "";
  const start = match.index + prefix.length;
  if (marker === "/" && start === 0) return { kind: "slash", start, query };
  if (marker === "@") return { kind: "mention", start, query };
  return null;
}

/** Trailing prose punctuation a writer might butt up against a mention. */
function stripTrailingPunctuation(token: string): string {
  return token.replace(/[),.;:]+$/g, "");
}

/**
 * Extract every distinct `@path` token from a message, in order, with trailing
 * prose punctuation stripped. Does NOT validate the paths (traversal guards,
 * existence checks) — that stays with the caller that knows the filesystem.
 */
export function extractMentionTokens(message: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of message.matchAll(MENTION_TOKEN_RE)) {
    const raw = match[2];
    if (!raw) continue;
    const token = stripTrailingPunctuation(raw);
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
