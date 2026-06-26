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
}

let { path, content }: Props = $props();

let instance: PierreFile<never> | null = null;

function mountCodeBlock(el: HTMLDivElement) {
  const options: FileOptions<never> = {
    theme: PIERRE_THEME,
    overflow: "scroll",
    // We render our own card chrome around the peek; suppress Pierre's header.
    disableFileHeader: true,
  };
  instance = new PierreFile<never>(options, workerManager);
  // Pierre's File renders plaintext (which reads as unstyled "markdown") unless
  // a language is set, so resolve it from the path's extension explicitly —
  // matching WalkthroughCodeBlock, which passes `lang`.
  instance.render({
    containerWrapper: el,
    file: { name: path, contents: content, lang: getFiletypeFromFileName(path) },
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
