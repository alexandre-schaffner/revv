<script lang="ts">
	import { untrack } from 'svelte';
	import { getFileSearchQuery, setFileSearchQuery } from '$lib/stores/sidebar.svelte';

	// Mirror SearchFilter.svelte's input UX: 300ms debounce so we don't thrash
	// the tree's setSearch on every keystroke.
	let inputValue = $state(getFileSearchQuery());
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Sync inputValue from the store when the store changes externally.
	// The store is cleared on swipe-back (`setSidebarView('prs')`), PR
	// switches, and scope toggles. The pane stays mounted across those, so
	// without this sync the input would visually retain stale text and the
	// pending debounce would re-apply the stale query 300ms later.
	// `untrack` on the inputValue read keeps local typing from re-triggering
	// this effect — only real store changes do.
	$effect(() => {
		const storeValue = getFileSearchQuery();
		untrack(() => {
			if (storeValue !== inputValue) {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
					debounceTimer = null;
				}
				inputValue = storeValue;
			}
		});
	});

	function handleInput(e: Event) {
		inputValue = (e.target as HTMLInputElement).value;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			setFileSearchQuery(inputValue);
			debounceTimer = null;
		}, 300);
	}

	function handleClear() {
		inputValue = '';
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		setFileSearchQuery('');
	}
</script>

<div class="flex items-center gap-1.5 px-3 py-2">
	<div class="relative flex-1">
		<svg
			class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.35-4.35" />
		</svg>
		<input
			class="h-7 w-full rounded-full border border-border bg-bg-elevated pl-8 pr-7 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
			placeholder="Search files..."
			value={inputValue}
			oninput={handleInput}
		/>
		{#if inputValue}
			<button
				class="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
				onclick={handleClear}
				aria-label="Clear search"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M18 6 6 18M6 6l12 12"/>
				</svg>
			</button>
		{/if}
	</div>
</div>
