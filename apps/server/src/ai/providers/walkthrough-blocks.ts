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
      patch: input.diff.patch,
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
