<script lang="ts">
	import { setSearchQuery } from '$lib/stores/prs.svelte';
	import { setFocusedId } from '$lib/stores/sidebar-nav.svelte';

	let { onAddRepo }: { onAddRepo: () => void } = $props();

	let inputValue = $state('');
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function handleInput(e: Event) {
		inputValue = (e.target as HTMLInputElement).value;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			setSearchQuery(inputValue);
			debounceTimer = null;
		}, 300);
	}

	function flushSearch(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		setSearchQuery(inputValue);
	}

	// Enter / ArrowDown highlight the first PR of the rendered list as if
	// the user were hovering it — pure visual cue via the sidebar-nav
	// store (drives the .sidebar-nav-focused class), no navigation. DOM
	// focus stays on the input so the user can keep typing.
	//
	// Repo groups default to collapsed, so on a fresh search the only
	// data-sidebar-nav nodes in the PR pane are the repo headers — which
	// is why the previous "first nav item" version landed the highlight
	// on a header instead of a PR. Here we look for an actual PR row
	// (data-nav-type="pr"); if none are mounted because every group is
	// closed, we click the first repo header to expand it and walk the
	// DOM again on the next frame.
	function highlightFirstPr(): boolean {
		const pr = document.querySelector<HTMLElement>(
			'.view-pane--prs [data-nav-type="pr"]',
		);
		const id = pr?.getAttribute('data-sidebar-nav');
		if (!id) return false;
		setFocusedId(id);
		return true;
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key !== 'Enter' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		flushSearch();
		requestAnimationFrame(() => {
			if (highlightFirstPr()) return;
			const firstGroup = document.querySelector<HTMLElement>(
				'.view-pane--prs [data-nav-type="repo"]',
			);
			if (!firstGroup) return;
			firstGroup.click();
			requestAnimationFrame(() => {
				highlightFirstPr();
			});
		});
	}

	function handleClear() {
		inputValue = '';
		setSearchQuery('');
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
			placeholder="Search PRs..."
			value={inputValue}
			oninput={handleInput}
			onkeydown={handleKeydown}
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
	<button
		class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-accent hover:text-accent"
		onclick={onAddRepo}
		title="Add repository"
		aria-label="Add repository"
	>
		<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M12 5v14M5 12h14"/>
		</svg>
	</button>
</div>
