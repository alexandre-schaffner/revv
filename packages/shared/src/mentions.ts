// The `@path` / `/command` grammar, shared by the web composer and the
// server's prompt builder so the two agree on what a mention token is.

export type MentionTrigger =
  | { readonly kind: "slash"; readonly start: number; readonly query: string }
  | { readonly kind: "mention"; readonly start: number; readonly query: string };

const TRIGGER_AT_CARET_RE = /(^|\s)([/@])([^\s]*)$/;

// Excludes backticks so a backticked `@path` example (e.g. in a system prompt)
// is not treated as a real mention.
const MENTION_TOKEN_RE = /(^|\s)@([^\s`]+)/g;

/**
 * The client's file-pill grammar, `@path[:line]`: capture 1 is the path,
 * capture 2 the optional line. Requires a file extension so a prose `@handle`
 * isn't captured. A source string, not a `RegExp`, so callers build their own
 * and no mutable `lastIndex` is shared across modules.
 */
export const MENTION_PATH_PATTERN = "@((?:[\\w.-]+/)*[\\w.-]+\\.[A-Za-z0-9]+)(?::(\\d+))?";

/**
 * Both markers trigger anywhere in the message, at start-of-input or after
 * whitespace: naming a command mid-sentence ("rewrite the body using /…") is
 * as ordinary as naming a file. A path (`/etc/hosts`), a URL (`https://…`) or
 * `and/or` either fails the boundary or yields a query no command matches, and
 * the composer only opens the menu when at least one item matches.
 */
export function detectMentionTrigger(textBeforeCaret: string): MentionTrigger | null {
  const match = TRIGGER_AT_CARET_RE.exec(textBeforeCaret);
  if (!match || match.index === undefined) return null;
  const prefix = match[1] ?? "";
  const marker = match[2];
  const query = match[3] ?? "";
  const start = match.index + prefix.length;
  if (marker === "/") return { kind: "slash", start, query };
  if (marker === "@") return { kind: "mention", start, query };
  return null;
}

const TRAILING_PUNCTUATION = new Set([")", ",", ".", ";", ":"]);

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(token[end - 1] as string)) end--;
  return token.slice(0, end);
}

/**
 * Does NOT validate the paths (traversal guards, existence checks) — that
 * stays with the caller that knows the filesystem.
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
