// ── agent-text ───────────────────────────────────────────────────────────────
//
// Normalization for agent-authored strings the UI renders as PLAIN TEXT rather
// than markdown: semantic-step titles, issue titles, issue descriptions.
//
// Agents intermittently HTML-escape these. By the time the model writes a
// chapter title it has been told that the neighbouring fields are rendered
// markdown and that artifacts are raw HTML documents, so it reaches for
// `Context &amp; design decisions`. In a markdown field that is harmless:
// `marked` passes the entity straight through and the browser shows `&`. In a
// plain-text field Svelte escapes the string a second time and the reader sees
// a literal `&amp;`.
//
// Normalizing at ingest rather than at render keeps the database holding
// exactly what the reader is supposed to see, so every consumer (UI, GitHub
// submission, chat context) gets the same string. Both MCP write paths call
// through here, which is what keeps them byte-for-byte identical (CLAUDE.md
// invariants #2 and #13).
//
// Deliberately NOT applied to markdown, code, diff or artifact content: those
// legitimately contain entities and must be stored verbatim.

/** The entities a model actually emits. A full HTML5 table would be noise. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // A literal space, not U+00A0. These are short plain-text labels; an
  // invisible non-breaking space in one only breaks wrapping.
  nbsp: " ",
};

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g;

/**
 * Decode HTML entities in an agent-authored plain-text field, then trim.
 *
 * Single-pass by construction, matching what a browser does: `&amp;lt;`
 * decodes to the literal `&lt;`, not to `<`. An unrecognized named entity is
 * left alone rather than dropped, so a title containing `&foo;` survives.
 *
 * The rare false positive — a chapter genuinely about the text `&amp;` — is
 * accepted. It loses to the common case by a wide margin, and a browser
 * address bar would make the same call.
 */
export function decodePlainText(value: string): string {
  return value
    .replace(ENTITY_RE, (match, dec: string | undefined, hex: string | undefined, name) => {
      if (dec !== undefined) return codePoint(Number.parseInt(dec, 10), match);
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), match);
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
    })
    .trim();
}

/** Numeric reference → character, falling back to the raw text when invalid. */
function codePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}
