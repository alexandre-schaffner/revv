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
import { prLensDiagramError } from "./prlens-doc";

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
function emptyBlockError(input: BlockVariantInput): string | null {
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

/**
 * Every field of a block whose markdown the web app scans for `prlens` fences:
 * prose content, and the annotation beside a code, diff or artifact block.
 */
function diagramBearingFields(input: BlockVariantInput): readonly (readonly [string, string])[] {
  const fields: (readonly [string, string])[] = [];
  if (input.markdown) fields.push(["markdown block content", input.markdown.content]);
  if (input.code?.annotation) fields.push(["code block annotation", input.code.annotation]);
  if (input.diff?.annotation) fields.push(["diff block annotation", input.diff.annotation]);
  if (input.artifact?.annotation) {
    fields.push(["artifact block annotation", input.artifact.annotation]);
  }
  return fields;
}

/**
 * The full content gate both write paths run before a block is persisted:
 * empty payloads, then unrenderable `prlens` diagrams. Returns a recoverable
 * error string for the agent, or null when the block is safe to store.
 *
 * Diagram validation is a hard rejection rather than the warn-and-save the
 * artifact theming lint uses, because the two failures differ in kind. A
 * hardcoded color still renders — wrong in one theme, readable in the other.
 * A rejected graph document renders nothing at all: the reader gets a schema
 * error and a JSON dump in the middle of the prose. Since the block write is
 * an idempotent upsert, erroring costs one retry and leaves nothing behind.
 */
export function blockContentError(input: BlockVariantInput): string | null {
  const empty = emptyBlockError(input);
  if (empty) return empty;

  for (const [label, markdown] of diagramBearingFields(input)) {
    const diagram = prLensDiagramError(markdown, label);
    if (diagram) return diagram;
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

/**
 * Any markup or code that could give the reader something to click, type in,
 * or toggle. Deliberately broad — a false negative (an interactive artifact we
 * fail to recognise) would produce a wrong warning, which is worse than a
 * missed one, since the check is advisory.
 */
const INTERACTIVE_RE =
  /<(button|input|select|textarea|details|summary)\b|addEventListener\s*\(|\son(click|change|input|keydown|pointerdown)\s*=/i;

/**
 * Warn when an artifact has no way for the reader to drive it. A static
 * artifact is a markdown block that cost a sandboxed iframe: the one thing the
 * block type exists for is the interaction. Warn-only, like the theming lint —
 * the write succeeds and the agent can correct the next block.
 */
export function artifactInteractivityWarning(input: BlockVariantInput): string | null {
  if (!input.artifact) return null;
  if (INTERACTIVE_RE.test(input.artifact.html)) return null;

  return "Warning: this artifact has no interactive control (no button, input, or event listener), so it is a picture the reader cannot drive — which a markdown block does better and cheaper. An artifact needs something to vary (step the trace, toggle the proposed fix, pick the input) plus a live state readout and a verdict. The block was saved; either replace it with markdown or give it a control.";
}

/**
 * The type ceiling an artifact must stay under. The injected baseline sets the
 * root to 13px sans against 16px walkthrough prose, so an artifact only ever
 * sizes *down*; a declaration above the ceiling makes the island shout over the
 * text it annotates. `rem` resolves against the untouched 16px root, not the
 * 13px body, so the thresholds differ per unit.
 */
const FONT_SIZE_DECL_RE = /font-size\s*:\s*([\d.]+)\s*(px|rem|em)/gi;
const FONT_SIZE_CEILING: Record<string, number> = { px: 13, rem: 0.85, em: 1.05 };

/** Height reserved for content that isn't there yet — the dead-space defect. */
const MIN_HEIGHT_DECL_RE = /min-height\s*:\s*([\d.]+)\s*(px|vh|rem|em)/gi;
const FIXED_HEIGHT_DECL_RE = /(?<!min-|max-)height\s*:\s*([\d.]+)\s*px/gi;
/** A `min-height` under this is a hairline, not a reservation (e.g. `min-height: 1px`). */
const MIN_HEIGHT_FLOOR_PX = 24;
/** Below this a fixed height is a control or a bar, not a reserved panel. */
const FIXED_HEIGHT_FLOOR_PX = 80;

/**
 * Warn about the two layout defects that survive every amount of prompting,
 * because they are invisible to an agent that never sees its own render:
 * type as large as the surrounding prose, and empty space reserved for content
 * that has not rendered yet. Warn-only, like the theming lint.
 */
export function artifactLayoutWarning(input: BlockVariantInput): string | null {
  if (!input.artifact) return null;

  const html = input.artifact.html;
  const issues: string[] = [];

  for (const match of html.matchAll(FONT_SIZE_DECL_RE)) {
    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase() ?? "";
    const ceiling = FONT_SIZE_CEILING[unit];
    if (ceiling === undefined || !Number.isFinite(value) || value <= ceiling) continue;
    issues.push(
      `font-size: ${match[1]}${unit} — the artifact must read smaller than the 16px prose around it, so never size above 13px (the injected baseline already sets it; only go down, to 12px for dense rows)`,
    );
    break;
  }

  const reserved = [...html.matchAll(MIN_HEIGHT_DECL_RE)].find((match) => {
    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (!Number.isFinite(value)) return false;
    return unit === "px" ? value >= MIN_HEIGHT_FLOOR_PX : value > 0;
  });
  const fixed = [...html.matchAll(FIXED_HEIGHT_DECL_RE)].find(
    (match) => Number(match[1]) >= FIXED_HEIGHT_FLOOR_PX,
  );
  if (reserved || fixed) {
    const decl = reserved ? `min-height: ${reserved[1]}${reserved[2]}` : `height: ${fixed?.[1]}px`;
    issues.push(
      `${decl} — the frame auto-sizes to its content, so reserved height renders as a band of empty space under the last row, which reads as a broken artifact. Drop it and let the layout grow; seed the verdict line with its pending text ("Not run yet — step to see where it lands") instead of holding space for it`,
    );
  }

  if (/<select\b/i.test(html)) {
    issues.push(
      "<select> — a native dropdown drags in unthemeable platform chrome and hides the scenarios that are the point of the artifact. With 2–4 options use a segmented row of small buttons with aria-pressed",
    );
  }

  if (issues.length === 0) return null;

  return `Warning: this artifact has layout defects you cannot see from here (found: ${issues.join("; ")}). The block was saved; correct it in this or a later block.`;
}

export function withArtifactWarnings(okText: string, input: BlockVariantInput): string {
  const warnings = [
    artifactThemingWarning(input),
    artifactInteractivityWarning(input),
    artifactLayoutWarning(input),
  ].filter((warning): warning is string => warning !== null);
  return warnings.length > 0 ? `${okText}\n\n${warnings.join("\n\n")}` : okText;
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
