<script lang="ts">
// Syntax-highlighted unified diff for a file-edit tool call, from the captured
// old/new text. Mounted lazily by ToolCallCard on expand.
import { pierreDiff } from "$lib/pierre/mount";

interface Props {
  /** File path — drives language detection and is not displayed. */
  path: string;
  oldText: string;
  newText: string;
}

let { path, oldText, newText }: Props = $props();
</script>

<div
	class="diff-peek"
	use:pierreDiff={{
		oldFile: { name: path, contents: oldText },
		newFile: { name: path, contents: newText },
	}}
></div>

<style>
	.diff-peek {
		max-height: 24rem;
		overflow: auto;
		border-radius: 0.375rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 50%, transparent);
	}
</style>
