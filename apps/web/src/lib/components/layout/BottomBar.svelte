<script lang="ts">
import type { Snippet } from "svelte";
import AgentSelector from "./AgentSelector.svelte";
import ModelSelector from "./ModelSelector.svelte";
import ThinkingEffortSelector from "./ThinkingEffortSelector.svelte";

interface Props {
  /** The page's status chrome (see `ShellChrome.status`). */
  status?: Snippet | undefined;
}

let { status }: Props = $props();
</script>

<div class="bottombar-row">
	<div class="bottombar-left">
		<div class="flex items-center gap-0.5">
			<AgentSelector />
			<ModelSelector />
			<ThinkingEffortSelector />
		</div>
	</div>

	<div class="bottombar-right">
		{@render status?.()}
	</div>
</div>

<style>
	.bottombar-row {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: space-between;
		background: var(--color-bg-secondary);
		padding: 0 var(--spacing-island-2x);
	}

	.bottombar-left {
		display: flex;
		align-items: center;
		gap: var(--spacing-inset);
	}

	.bottombar-right {
		display: flex;
		align-items: center;
		gap: var(--spacing-island);
	}
</style>
