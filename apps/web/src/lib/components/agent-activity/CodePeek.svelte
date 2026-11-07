<script lang="ts">
// A syntax-highlighted Pierre code block for FilePeek: the file read from the
// clone, or the tool's captured output when the file can't be read.
import { getFiletypeFromFileName } from "@pierre/diffs";
import { pierreFile } from "$lib/pierre/mount";

interface Props {
  /** File path — drives the language and is not displayed. */
  path: string;
  content: string;
  /**
   * Render only the window from this 1-based line (the gutter keeps absolute
   * line numbers), for a `Read(offset, limit)`.
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
