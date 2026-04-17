<script lang="ts">
	import {
		Root as PopoverRoot,
		Trigger as PopoverTrigger,
		Content as PopoverContent,
	} from '$lib/components/ui/popover/index.js';
	import { getSettings, updateSettings } from '$lib/stores/settings.svelte';
	import { agentSupportsThinkingEffort } from '$lib/constants/models';
	import type { ThinkingEffort, AiAgent } from '@revv/shared';
	import Brain from '@lucide/svelte/icons/brain';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';

	const OPTIONS: { label: string; value: ThinkingEffort }[] = [
		{ label: 'High', value: 'high' },
		{ label: 'Medium', value: 'medium' },
		{ label: 'Low', value: 'low' },
	];

	let open = $state(false);
	let currentAgent = $derived((getSettings()?.aiAgent ?? 'opencode') as AiAgent);
	let visible = $derived(agentSupportsThinkingEffort(currentAgent));
	let currentEffort = $derived((getSettings()?.aiThinkingEffort ?? 'medium') as ThinkingEffort);
	let currentLabel = $derived(OPTIONS.find((o) => o.value === currentEffort)?.label ?? 'Medium');

	function select(value: ThinkingEffort) {
		updateSettings({ aiThinkingEffort: value });
		open = false;
	}
</script>

{#if visible}
<PopoverRoot bind:open>
	<PopoverTrigger>
		<button
			class="flex items-center gap-1.5 rounded-md bg-bg-secondary px-2 py-1 transition-colors hover:bg-bg-tertiary"
		>
			<Brain size={12} class="text-text-muted" />
			<span class="text-xs text-text-secondary">{currentLabel}</span>
			<ChevronDown size={10} class="text-text-muted" />
		</button>
	</PopoverTrigger>
	<PopoverContent class="w-36 p-1" align="start" side="top">
		{#each OPTIONS as opt (opt.value)}
			<button
				class="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.value)}
			>
				{opt.label}
				{#if currentEffort === opt.value}
					<Check size={12} class="text-accent" />
				{/if}
			</button>
		{/each}
	</PopoverContent>
</PopoverRoot>
{/if}
