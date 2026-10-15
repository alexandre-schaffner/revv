// ── CODEOWNERS ──────────────────────────────────────────────────────────────
//
// GitHub tells us which review requests came from CODEOWNERS, but not which
// owner covers which file. So the Conversation tab reads the base branch's
// CODEOWNERS (the server parses it) and matches it against the PR's changed
// files (the client, which holds the file list).
//
// Matching follows GitHub's documented subset of gitignore: the last
// matching rule wins, a rule with no owners leaves its paths unowned, and
// `!` negation and `[ ]` ranges aren't supported.

export interface CodeownersRule {
  /** 1-based line in the file, for pointing at the rule. */
  readonly line: number;
  readonly pattern: string;
  /** `@login`, `@org/team`, or an email, as written. Empty = unowned. */
  readonly owners: readonly string[];
}

export interface CodeownersFile {
  /** Where GitHub found it: `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`. */
  readonly path: string;
  /** The branch it was read from: the PR's base. */
  readonly ref: string;
  readonly rules: readonly CodeownersRule[];
}

/** Where GitHub looks for the file, in the order it looks. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    // An escaped space (`\ `) belongs to the pattern.
    const [pattern, ...owners] = line.split(/(?<!\\)\s+/);
    if (!pattern || pattern.startsWith("!")) return;
    rules.push({ line: index + 1, pattern: pattern.replace(/\\ /g, " "), owners });
  });
  return rules;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** One CODEOWNERS pattern as a regex over repo-relative paths (no leading `/`). */
export function codeownersPatternRegex(pattern: string): RegExp {
  let p = pattern;
  const directoryOnly = p.endsWith("/");
  if (directoryOnly) p = p.slice(0, -1);
  // A slash at the start or in the middle anchors to the repo root; a bare
  // name (`*.js`, `logs`) matches at any depth.
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\//, "");

  let body = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === "*" && p[i + 1] === "*") {
      const slashAfter = p[i + 2] === "/";
      body += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (ch === "*") {
      body += "[^/]*";
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += escapeRegex(ch);
    }
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A pattern naming a directory owns everything beneath it, but GitHub
  // reads a wildcard last segment as files only: `docs/*` owns
  // `docs/a.md`, not `docs/guides/b.md`.
  const lastSegment = p.split("/").pop() ?? "";
  const wildcardLeaf = lastSegment.includes("*") && !lastSegment.includes("**");
  const suffix = directoryOnly ? "/.*$" : wildcardLeaf ? "$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${body}${suffix}`);
}

/**
 * The owners of each path under `rules`: last matching rule wins. A path no
 * rule matches, or whose last match lists nobody, maps to `[]`.
 */
export function codeownersFor(
  rules: readonly CodeownersRule[],
  paths: readonly string[],
): Map<string, readonly string[]> {
  const compiled = rules.map((rule) => ({ rule, regex: codeownersPatternRegex(rule.pattern) }));
  const result = new Map<string, readonly string[]>();
  for (const path of paths) {
    const clean = path.replace(/^\//, "");
    let owners: readonly string[] = [];
    for (let i = compiled.length - 1; i >= 0; i--) {
      const entry = compiled[i];
      if (entry?.regex.test(clean)) {
        owners = entry.rule.owners;
        break;
      }
    }
    result.set(path, owners);
  }
  return result;
}
