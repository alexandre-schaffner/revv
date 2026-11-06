<script lang="ts">
// Highlighted preview of the file a Read/Write/Edit touched, mounted when its
// card opens. Falls back to the agent's captured output when the file can't be
// read.
import { onMount } from "svelte";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import CodePeek from "./CodePeek.svelte";
import { getActivityPr, loadRepoFile, type RepoFile } from "./repo-file";

interface Props {
  path: string;
  fallbackOutput?: string | undefined;
  /**
   * For a windowed Read: `offset` is the 1-based first line, `limit` the line
   * count (null/undefined: to the end). Omit both for the whole file.
   */
  offset?: number | undefined;
  limit?: number | null | undefined;
}

let { path, fallbackOutput, offset, limit }: Props = $props();

const prId = getActivityPr();
let state = $state<RepoFile | { status: "loading" }>({ status: "loading" });

const startLine = $derived(offset != null && offset > 0 ? offset : 1);
const lineCount = $derived.by(() => {
  if (offset == null && (limit == null || limit <= 0)) return undefined;
  if (limit != null && limit > 0) return limit;
  if (state.status !== "ready") return undefined;
  const total = state.content.replace(/\n$/, "").split("\n").length;
  return Math.max(1, total - (startLine - 1));
});

onMount(async () => {
  state = prId
    ? await loadRepoFile(prId, path)
    : { status: "unavailable", message: "Couldn't preview file." };
});
</script>

<div class="file-peek">
	{#if state.status === "loading"}
		<div class="file-peek-status">
			<Dotmatrix variant="square-9" size="small" />
			<span>Loading {path}…</span>
		</div>
	{:else if state.status === "ready"}
		<CodePeek path={path} content={state.content} startLine={startLine} lineCount={lineCount} />
	{:else}
		<div class="file-peek-status">{state.message}</div>
		{#if fallbackOutput}
			<CodePeek path={path} content={fallbackOutput} />
		{/if}
	{/if}
</div>

<style>
	.file-peek {
		overflow: hidden;
		border-radius: 0.375rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 50%, transparent);
	}

	.file-peek-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}
</style>
