<script lang="ts">
import type { ReviewFile } from "$lib/stores/diff-files.svelte";
import { getDiffMode, getDiffWrap } from "$lib/stores/diff-prefs.svelte";
import DiffViewerInner from "./DiffViewerInner.svelte";
import type { CommentRowsTrigger } from "./pierre-diff-adapter";
import { ThreadAnnotations } from "./thread-annotations.svelte";

interface Props {
  /** The PR under review; its first pass marks the gutter. */
  prId: string;
  file: ReviewFile;
  scrollRoot: HTMLElement | null;
  /** Opens a comment input over the given rendered rows (keyboard `c`). */
  commentTrigger: CommentRowsTrigger | null;
}

let { prId, file, commentTrigger, scrollRoot }: Props = $props();

const threads = new ThreadAnnotations(
  () => prId,
  () => file.path,
);

const mode = $derived(getDiffMode());
const wrap = $derived(getDiffWrap());

// A new key remounts the Pierre instance. Wrap is keyed too: Pierre lays out
// overflow at render, and a prerendered (scrolling) SSR body can't be
// re-flowed in place.
const viewKey = $derived(`${file.path}::${mode}::${wrap ? "wrap" : "scroll"}`);
</script>

{#key viewKey}
	<DiffViewerInner {prId} {file} {mode} {wrap} {threads} {commentTrigger} {scrollRoot} />
{/key}
