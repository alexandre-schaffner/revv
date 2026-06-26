<script lang="ts">
// ── DiffPeek ─────────────────────────────────────────────────────────────────
//
// Syntax-highlighted unified diff for a file-edit tool call. Renders straight
// from the captured old/new text via Pierre's FileDiff (no patch string needed)
// — the same renderer the walkthrough diff blocks use, minus the annotation
// chrome. Mounted lazily by ToolCallCard on expand.
import { FileDiff, type FileDiffOptions } from "@pierre/diffs";
import { PIERRE_THEME } from "@revv/shared";
import { workerManager } from "$lib/utils/worker-pool";

interface Props {
  /** File path — drives language detection and is not displayed. */
  path: string;
  oldText: string;
  newText: string;
}

let { path, oldText, newText }: Props = $props();

let instance: FileDiff<never> | null = null;

function mountDiff(el: HTMLDivElement) {
  const options: FileDiffOptions<never> = {
    diffStyle: "unified",
    theme: PIERRE_THEME,
    overflow: "scroll",
    disableFileHeader: true,
  };
  instance = new FileDiff<never>(options, workerManager);
  instance.render({
    containerWrapper: el,
    oldFile: { name: path, contents: oldText },
    newFile: { name: path, contents: newText },
  });
  return {
    destroy() {
      instance?.cleanUp();
      instance = null;
    },
  };
}
</script>

<div class="diff-peek" use:mountDiff></div>

<style>
	.diff-peek {
		max-height: 24rem;
		overflow: auto;
		border-radius: 0.375rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 50%, transparent);
	}
</style>
