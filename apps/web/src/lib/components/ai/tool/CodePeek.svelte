<script lang="ts">
// ── CodePeek ─────────────────────────────────────────────────────────────────
//
// A lightweight, syntax-highlighted Pierre code block for file-related tool
// output — the same renderer the walkthrough code blocks use, minus the
// annotation/jump-to-diff machinery. Pierre infers the language from the file
// name's extension. Used by FilePeek (fetched file content) and by ToolCallCard
// for captured output that is file content.
import { type FileOptions, getFiletypeFromFileName, File as PierreFile } from "@pierre/diffs";
import { PIERRE_THEME } from "@revv/shared";
import { workerManager } from "$lib/utils/worker-pool";

interface Props {
  /** File path — drives Pierre's language detection and is not displayed. */
  path: string;
  /** File contents / code to render. */
  content: string;
  /**
   * Render only a window of `content` (the gutter keeps absolute line numbers)
   * instead of the whole file. `startLine` is 1-based. Used by the Read peek so
   * a `Read(offset, limit)` shows just the lines it read.
   */
  startLine?: number | undefined;
  lineCount?: number | undefined;
}

let { path, content, startLine, lineCount }: Props = $props();

let instance: PierreFile<never> | null = null;

function mountCodeBlock(el: HTMLDivElement) {
  const options: FileOptions<never> = {
    theme: PIERRE_THEME,
    overflow: "scroll",
    // We render our own card chrome around the peek; suppress Pierre's header.
    disableFileHeader: true,
  };
  instance = new PierreFile<never>(options, workerManager);
  // Pierre virtualizes to a line window via `renderRange` (0-based start +
  // count) while the gutter still shows absolute line numbers. Zero buffers
  // keep the block exactly the window's height, not the whole file's.
  const renderRange =
    startLine != null && lineCount != null && lineCount > 0
      ? { startingLine: startLine - 1, totalLines: lineCount, bufferBefore: 0, bufferAfter: 0 }
      : undefined;
  // Pierre's File renders plaintext (which reads as unstyled "markdown") unless
  // a language is set, so resolve it from the path's extension explicitly —
  // matching WalkthroughCodeBlock, which passes `lang`.
  instance.render({
    containerWrapper: el,
    file: { name: path, contents: content, lang: getFiletypeFromFileName(path) },
    ...(renderRange ? { renderRange } : {}),
  });
  return {
    destroy() {
      instance?.cleanUp();
      instance = null;
    },
  };
}
</script>

<div class="code-peek" use:mountCodeBlock></div>

<style>
	.code-peek {
		max-height: 24rem;
		overflow: auto;
	}
</style>
