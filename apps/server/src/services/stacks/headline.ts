// ── Naming a stack from its titles ──────────────────────────────────────────
//
// The fallback when no model names the stack (none configured, it failed, or
// it hasn't answered yet): something better than "4 pull requests", read off
// the PR titles alone.

/** `feat(stacks)!: add the rail` → scope `stacks`, rest `add the rail`. */
const CONVENTIONAL = /^\s*[a-z]+(?:\(([^)]+)\))?!?:\s*/i;

function strip(title: string): { scope: string | null; rest: string } {
  const match = title.match(CONVENTIONAL);
  return match
    ? { scope: match[1]?.trim() ?? null, rest: title.slice(match[0].length).trim() }
    : { scope: null, rest: title.trim() };
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A shared conventional-commit scope ("Stacks"), else the words every title
 * starts with ("Billing retries: …" ×3), else the top layer's title, which
 * names where the stack ends up. Titles base first.
 */
export function headlineFromTitles(titles: readonly string[]): string {
  const parts = titles.map(strip);
  const scopes = new Set(parts.map((p) => p.scope?.toLowerCase() ?? ""));
  const scope = parts[0]?.scope;
  if (scope && scopes.size === 1) return sentenceCase(scope.replace(/[-_/]+/g, " "));

  const words = parts.map((p) => p.rest.split(/\s+/));
  const shared: string[] = [];
  for (let i = 0; ; i++) {
    const word = words[0]?.[i];
    if (!word || !words.every((w) => w[i]?.toLowerCase() === word.toLowerCase())) break;
    shared.push(word);
  }
  const prefix = shared.join(" ").replace(/[:,\-–—]+$/, "");
  if (shared.length >= 2) return sentenceCase(prefix);

  return sentenceCase(parts.at(-1)?.rest ?? titles.at(-1) ?? "");
}

/** The first sentence of a paragraph of prose. */
export function firstSentence(text: string): string | null {
  const flat = text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}
