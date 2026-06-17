// ── walkthrough-blocks ───────────────────────────────────────────────────────
//
// Shared block-variant validation + construction for the two MCP tool surfaces
// that write `walkthrough_blocks` rows: the generation pipeline
// (`walkthrough-tools/phase-b-handlers.ts`) and the post-completion chat-edit
// path (`chat-edit-tools/`). Both accept the same four-variant block-content
// shape (markdown | code | diff | artifact) and MUST validate and build it
// identically.
//
// Keeping that logic here is the concrete expression of CLAUDE.md invariant #2
// ("tool handler implementations are always shared in-process code") and #13
// ("agent-path parity"): the artifact size cap, the variant-exclusivity rule,
// and the typed-block construction cannot drift between the generation path and
// the chat-edit path because there is only one copy.

import type {
  ArtifactBlock,
  CodeBlock,
  DiffBlock,
  MarkdownBlock,
  WalkthroughBlock,
} from "@revv/shared";

/**
 * Max serialized artifact HTML, enforced identically on both write paths. The
 * document is persisted verbatim and later rendered in a sandboxed iframe; the
 * cap keeps a runaway model from writing a multi-megabyte block into SQLite.
 */
export const MAX_ARTIFACT_HTML_BYTES = 256 * 1024;

/**
 * The four mutually-exclusive block-content variants. Structurally identical to
 * the chat-edit `blockContentSchema` inference and the generation pipeline's
 * `add_diff_step` / `add_semantic_step.initial_block` shapes — both decode
 * their input straight into this type.
 */
export interface BlockVariantInput {
  readonly markdown?: { readonly content: string } | null | undefined;
  readonly code?:
    | {
        readonly file_path: string;
        readonly start_line: number;
        readonly end_line: number;
        readonly language: string;
        readonly content: string;
        readonly annotation: string | null;
        readonly annotation_position: "left" | "right";
      }
    | null
    | undefined;
  readonly diff?:
    | {
        readonly file_path: string;
        readonly patch: string;
        readonly annotation: string | null;
        readonly annotation_position: "left" | "right";
      }
    | null
    | undefined;
  readonly artifact?:
    | {
        readonly html: string;
        readonly annotation: string | null;
        readonly annotation_position: "left" | "right";
      }
    | null
    | undefined;
}

/** Count the populated variants. Both tool surfaces require exactly 1. */
export function blockVariantCount(input: BlockVariantInput): number {
  let n = 0;
  if (input.markdown != null) n++;
  if (input.code != null) n++;
  if (input.diff != null) n++;
  if (input.artifact != null) n++;
  return n;
}

/**
 * Reject blocks whose payload would render as an empty box. An annotation on a
 * code/diff block reads as commentary *about* code that isn't there — use a
 * markdown block for prose-only content instead. Returns a recoverable error
 * string for the agent, or null when the content is acceptable.
 */
export function emptyBlockError(input: BlockVariantInput): string | null {
  if (input.markdown && input.markdown.content.trim().length === 0) {
    return "Error: markdown block requires non-empty content. Either fill it in or omit the block.";
  }
  if (input.code && input.code.content.trim().length === 0) {
    return "Error: code block requires non-empty content. Use a markdown block if you only want to write prose; an annotation without code reads as commentary about nothing.";
  }
  if (input.diff && input.diff.patch.trim().length === 0) {
    return "Error: diff block requires a non-empty patch. Use a markdown block for prose-only content.";
  }
  if (input.artifact) {
    const html = input.artifact.html.trim();
    if (html.length === 0) {
      return "Error: artifact block requires non-empty html. Use a markdown block for prose-only content.";
    }
    const byteLength = new TextEncoder().encode(input.artifact.html).byteLength;
    if (byteLength > MAX_ARTIFACT_HTML_BYTES) {
      return `Error: artifact html is too large (${byteLength} bytes). Keep artifacts under ${MAX_ARTIFACT_HTML_BYTES} bytes.`;
    }
  }
  return null;
}

const FUNCTIONAL_COLOR_RE = /\b(rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color)\s*\(/i;
const HEX_COLOR_VALUE_RE = /[:\s]#[0-9a-fA-F]{3,8}\b/;
const FONT_FAMILY_DECL_RE = /font-family\s*:\s*([^;{}]+)/gi;
const GENERIC_FONT_FAMILIES = new Set([
  "inherit",
  "initial",
  "unset",
  "revert",
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-monospace",
  "cursive",
  "fantasy",
]);

function isGenericFontFamilyList(value: string): boolean {
  const families = value
    .split(",")
    .map((family) => family.trim().toLowerCase())
    .filter((family) => family.length > 0);

  return families.length > 0 && families.every((family) => GENERIC_FONT_FAMILIES.has(family));
}

/**
 * Best-effort theme-safety lint for artifact HTML. Warn-only by design: the
 * write still succeeds, and callers append the returned message to the MCP
 * success result so the agent can self-correct on later blocks.
 */
export function artifactThemingWarning(input: BlockVariantInput): string | null {
  if (!input.artifact) return null;

  const html = input.artifact.html;
  const issues = new Set<string>();

  if (HEX_COLOR_VALUE_RE.test(html)) {
    // Warn-only accepts the residual false positive where an all-hex id selector
    // like `#fad { ... }` appears after whitespace.
    issues.add("hex color literal");
  }
  if (FUNCTIONAL_COLOR_RE.test(html)) {
    issues.add("rgb()/hsl()/oklch() color");
  }

  for (const match of html.matchAll(FONT_FAMILY_DECL_RE)) {
    const value = match[1];
    if (!value) continue;
    if (value.includes("var(--font")) continue;
    if (isGenericFontFamilyList(value)) continue;
    issues.add("literal font-family");
    break;
  }

  if (issues.size === 0) return null;

  return `Warning: this artifact hardcodes styling that won't adapt to light/dark theme (found: ${Array.from(issues).join(", ")}). Style with the injected theme variables instead — var(--color-bg-primary), var(--color-accent), var(--font-sans)/var(--font-mono), var(--radius-card) — so it matches the app and flips with the theme. The block was saved; correct it in this or a later block.`;
}

export function withArtifactThemingWarning(okText: string, input: BlockVariantInput): string {
  const warning = artifactThemingWarning(input);
  return warning ? `${okText}\n\n${warning}` : okText;
}

/**
 * A unified-diff hunk header carrying explicit ranges: `@@ -a[,b] +c[,d] @@`.
 * A bare `@@`, a `@@ section label @@`, or a header with missing ranges is
 * malformed — Pierre's parser yields zero hunks for it and the diff renders as
 * a blank panel.
 */
const VALID_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

const isHunkHeader = (line: string): boolean => line.startsWith("@@");

/**
 * Synthesize a hunk header from its body line counts. The true source line
 * numbers are unrecoverable (a diff block carries no anchor), so ranges start
 * at line 1; git's `-0,0` convention marks an empty side so a pure
 * insertion/deletion still parses.
 */
function synthesizeHunkHeader(body: readonly string[]): string {
  let removed = 0;
  let added = 0;
  let context = 0;
  for (const line of body) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
    else context++;
  }
  const oldCount = removed + context;
  const newCount = added + context;
  const oldStart = oldCount === 0 ? 0 : 1;
  const newStart = newCount === 0 ? 0 : 1;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/**
 * Ensure every hunk in a unified-diff patch has a valid `@@ -a,b +c,d @@`
 * header. Models hand-writing a "conceptual" diff routinely emit a bare `@@`
 * (or omit the header entirely); Pierre's `parsePatchFiles` then parses the
 * file but produces zero hunks, so the diff block renders blank. We rewrite
 * only malformed headers — valid patches pass through unchanged (idempotent)
 * and body lines are never modified. Applied on write so stored patches are
 * always renderable.
 */
export function normalizeDiffPatch(patch: string): string {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex(isHunkHeader);

  // No hunk header at all: treat the whole body as one headerless hunk.
  if (firstHunk === -1) {
    if (patch.trim().length === 0) return patch;
    return `${synthesizeHunkHeader(lines)}\n${patch}`;
  }

  const out: string[] = lines.slice(0, firstHunk);
  let i = firstHunk;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    let j = i + 1;
    while (j < lines.length && !isHunkHeader(lines[j] ?? "")) j++;
    const body = lines.slice(i + 1, j);
    out.push(VALID_HUNK_HEADER.test(header) ? header : synthesizeHunkHeader(body));
    out.push(...body);
    i = j;
  }
  return out.join("\n");
}

/**
 * Construct a typed `WalkthroughBlock` from exactly one populated variant.
 * Returns null when no variant is present — callers validate variant count
 * with {@link blockVariantCount} and reject empty content with
 * {@link emptyBlockError} before calling. `order` is derived deterministically
 * from `(semanticStepIndex, stepIndex)` so the same block always sorts the same
 * way regardless of which tool wrote it.
 */
export function buildBlock(
  blockId: string,
  semanticStepIndex: number,
  stepIndex: number,
  input: BlockVariantInput,
): WalkthroughBlock | null {
  const order = semanticStepIndex * 10000 + stepIndex;

  if (input.markdown) {
    const md: MarkdownBlock = {
      type: "markdown",
      id: blockId,
      order,
      phase: "diff_analysis",
      semanticStepIndex,
      stepIndex,
      content: input.markdown.content,
    };
    return md;
  }
  if (input.code) {
    const code: CodeBlock = {
      type: "code",
      id: blockId,
      order,
      phase: "diff_analysis",
      semanticStepIndex,
      stepIndex,
      filePath: input.code.file_path,
      startLine: input.code.start_line,
      endLine: input.code.end_line,
      language: input.code.language,
      content: input.code.content,
      annotation: input.code.annotation,
      annotationPosition: input.code.annotation_position,
    };
    return code;
  }
  if (input.diff) {
    const diff: DiffBlock = {
      type: "diff",
      id: blockId,
      order,
      phase: "diff_analysis",
      semanticStepIndex,
      stepIndex,
      filePath: input.diff.file_path,
      patch: normalizeDiffPatch(input.diff.patch),
      annotation: input.diff.annotation,
      annotationPosition: input.diff.annotation_position,
    };
    return diff;
  }
  if (input.artifact) {
    const artifact: ArtifactBlock = {
      type: "artifact",
      id: blockId,
      order,
      phase: "diff_analysis",
      semanticStepIndex,
      stepIndex,
      html: input.artifact.html,
      annotation: input.artifact.annotation,
      annotationPosition: input.artifact.annotation_position,
    };
    return artifact;
  }
  return null;
}

/**
 * The two `walkthrough_blocks` columns derived from a built block: the variant
 * `type` discriminator and the JSON-serialized payload written to `data`.
 * Centralized here so no write path hand-writes `JSON.stringify(block)` — the
 * serialization that turns a typed block into a row is this module's
 * responsibility, the same way construction is, and must not drift between the
 * generation and chat-edit paths (CLAUDE.md #2, #13).
 */
export function blockRow(block: WalkthroughBlock): {
  type: WalkthroughBlock["type"];
  data: string;
} {
  return { type: block.type, data: JSON.stringify(block) };
}
