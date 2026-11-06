<script lang="ts">
// Shown while a PR has no conversation: an intro and starter prompts. The
// PR-aware prompts are asked for only here, so a PR the user already chatted
// about never spends tokens on them.
import Robot from "phosphor-svelte/lib/Robot";
import {
  FALLBACK_PROMPTS,
  fetchSuggestions,
  getSuggestions,
  isSuggestionsLoading,
} from "$lib/chat/suggestions.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { cn } from "$lib/utils.js";

interface Props {
  prId: string | null;
  stacked: boolean;
  /** Room left under the content for the floating composer. */
  bottomInset: number;
  onSelect: (prompt: string) => void;
}

let { prId, stacked, bottomInset, onSelect }: Props = $props();

const suggestions = $derived(prId ? getSuggestions(prId) : null);
const prompts = $derived<readonly string[]>(suggestions ?? FALLBACK_PROMPTS);
const loading = $derived(prId ? isSuggestionsLoading(prId) && suggestions === null : false);

$effect(() => {
  if (prId) fetchSuggestions(prId);
});
</script>

<div
	data-slot="conversation-empty-state"
	class={cn(
		"flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center text-muted-foreground",
		stacked ? "mx-auto w-full max-w-3xl" : "",
	)}
	style="padding-bottom: calc({bottomInset}px + 1rem)"
>
	<div class="opacity-40">
		<Robot size={32} />
	</div>
	<h3 class="text-sm font-medium">Ask the agent about this pull request</h3>
	<p class="max-w-[280px] text-xs">
		The agent runs inside the PR's worktree and can read the code, propose fixes, and commit them on a working branch.
	</p>
	<div
		data-slot="suggestion"
		role="group"
		aria-label="Suggestions"
		class="flex w-full flex-wrap items-center gap-2 mt-3 justify-center"
	>
		{#each prompts as prompt (prompt)}
			<Button
				data-slot="suggestion-item"
				type="button"
				variant="outline"
				size="sm"
				class="h-auto max-w-full cursor-pointer whitespace-normal rounded-full px-4 py-1.5 text-center"
				disabled={!prId || loading}
				onclick={() => onSelect(prompt)}
			>
				{prompt}
			</Button>
		{/each}
	</div>
</div>
