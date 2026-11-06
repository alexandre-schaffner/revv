<script lang="ts">
// A syntax-highlighted Pierre code block for file-related tool output: FilePeek
// (fetched file content) and ToolCallCard's captured file content.
import { getFiletypeFromFileName } from "@pierre/diffs";
import { pierreFile } from "$lib/pierre/mount";

interface Props {
  /** File path — drives the language and is not displayed. */
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

// Zero buffers keep the block exactly the window's height, not the whole file's.
const renderRange = $derived(
  startLine != null && lineCount != null && lineCount > 0
    ? { startingLine: startLine - 1, totalLines: lineCount, bufferBefore: 0, bufferAfter: 0 }
    : undefined,
);
</script>

<!-- Pierre renders plaintext unless a language is set, so it comes from the path. -->
<div
	class="code-peek"
	use:pierreFile={{
		file: { name: path, contents: content, lang: getFiletypeFromFileName(path) },
		renderRange,
	}}
></div>

<style>
	.code-peek {
		max-height: 24rem;
		overflow: auto;
	}
</style>
