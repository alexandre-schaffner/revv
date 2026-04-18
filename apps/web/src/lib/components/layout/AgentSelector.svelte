<script lang="ts">
	import {
		Root as PopoverRoot,
		Trigger as PopoverTrigger,
		Content as PopoverContent,
	} from '$lib/components/ui/popover/index.js';
	import {
		getSettings,
		updateSettings,
		getAvailableModels,
		fetchModels,
	} from '$lib/stores/settings.svelte';
	import { getDefaultModel } from '$lib/constants/models';
	import type { AiAgent } from '@revv/shared';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import AnthropicIcon from '$lib/components/icons/AnthropicIcon.svelte';
	import OpenCodeIcon from '$lib/components/icons/OpenCodeIcon.svelte';

	const AGENT_OPTIONS = [
		{ label: 'OpenCode', value: 'opencode' as AiAgent, icon: OpenCodeIcon },
		{ label: 'Claude Code', value: 'claude' as AiAgent, icon: AnthropicIcon },
	];

	let open = $state(false);

	let currentAgent = $derived((getSettings()?.aiAgent ?? 'opencode') as AiAgent);
	let currentLabel = $derived(AGENT_OPTIONS.find((a) => a.value === currentAgent)?.label ?? 'OpenCode');
	let CurrentIcon = $derived(AGENT_OPTIONS.find((a) => a.value === currentAgent)?.icon ?? OpenCodeIcon);

	/**
	 * Pick a valid model for the new agent from the cached list, falling back
	 * to the hardcoded default if the cache is empty. This guarantees the
	 * model dropdown is in a consistent state the moment the agent changes,
	 * rather than briefly showing a model name that doesn't exist in the
	 * new agent's catalog.
	 */
	function pickModelForAgent(value: AiAgent): string {
		const cached = getAvailableModels(value);
		const fallback = getDefaultModel(value);
		if (cached.length === 0) return fallback;
		// Prefer the default if it's in the list; otherwise the first entry.
		return cached.find((m) => m.value === fallback)?.value ?? cached[0]!.value;
	}

	function select(value: AiAgent) {
		// If the cache is cold (e.g. app-start prefetch hadn't completed yet),
		// kick a fetch so subsequent agent switches are race-free.
		void fetchModels(value);
		updateSettings({ aiAgent: value, aiModel: pickModelForAgent(value) });
		open = false;
	}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		<button
			class="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-bg-secondary"
		>
			<div class="h-1.5 w-1.5 rounded-full bg-accent"></div>
			<CurrentIcon size={12} class="text-text-muted" />
			<span class="text-xs text-text-secondary">{currentLabel}</span>
			<ChevronDown size={10} class="text-text-muted" />
		</button>
	</PopoverTrigger>
	<PopoverContent class="w-40 p-1" align="start" side="top">
		{#each AGENT_OPTIONS as opt (opt.value)}
			<button
				class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.value)}
			>
				<opt.icon size={12} class="text-text-muted" />
				<span class="flex-1 text-left">{opt.label}</span>
				{#if currentAgent === opt.value}
					<Check size={12} class="text-accent" />
				{/if}
			</button>
		{/each}
	</PopoverContent>
</PopoverRoot>
