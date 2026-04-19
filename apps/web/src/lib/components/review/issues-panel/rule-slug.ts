import type { WalkthroughIssue } from '@revv/shared';

/**
 * Generate an ESLint-rule-ID-style slug from a walkthrough issue for display
 * only. The result looks like `async/unhandled-error` or `security/no-eval` —
 * it's not a real rule ID, just a scannable token that gives every row a
 * terminal-friendly identifier in the spirit of `eslint .` output.
 *
 * Returns `null` for very short or low-information titles; the row then
 * falls back to no slug rather than showing something awkward like
 * `/findings`.
 *
 * Contract: deterministic per (severity, title). The same issue always
 * produces the same slug — the UI never shifts across re-renders.
 */
export function ruleSlugFor(issue: WalkthroughIssue): string | null {
    const words = extractSignificantWords(issue.title);
    if (words.length === 0) return null;

    // Namespace — first content word, kebab-cased. Gives rows a rough
    // "category" at a glance.
    const namespace = kebab(words[0]!);
    if (!namespace) return null;

    // Rule name — next 2-3 content words, joined. If only one word is
    // available we fall back to the severity word as the rule name so the
    // slug still has a "namespace/rule" shape.
    const ruleWords = words.slice(1, 4);
    if (ruleWords.length === 0) {
        return `${namespace}/${issue.severity}`;
    }
    const rule = ruleWords.map(kebab).filter(Boolean).join('-');
    if (!rule) return `${namespace}/${issue.severity}`;

    return `${namespace}/${rule}`;
}

// Lowercase words of 3+ chars that aren't common stop-words. The short list
// below covers the most frequent connective tokens a model emits in issue
// titles — enough to produce readable slugs without going full NLP.
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet',
    'of', 'in', 'on', 'at', 'to', 'from', 'by', 'as', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do',
    'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might',
    'this', 'that', 'these', 'those', 'it', 'its', 'with', 'without',
    'when', 'where', 'why', 'how', 'what', 'which', 'into', 'onto',
]);

function extractSignificantWords(title: string): string[] {
    return title
        .toLowerCase()
        // Strip anything that isn't a letter, digit, or whitespace — strip
        // punctuation, backticks, quotes, code-like identifiers lose their
        // symbols but keep their alpha runs.
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function kebab(word: string): string {
    // Already lowercase (see extractSignificantWords). Just guard against
    // empty / non-alnum residue.
    return word.replace(/[^a-z0-9]/g, '');
}
