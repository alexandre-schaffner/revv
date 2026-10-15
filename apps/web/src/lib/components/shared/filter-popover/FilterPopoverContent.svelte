<script lang="ts">
import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
import type { Snippet } from "svelte";
import * as Popover from "$lib/components/ui/popover";

// The body of a checklist filter popover: a title with an optional Clear, a
// search field, and one scroll region for every section below it. Shared by
// the sidebar's creator filter and the Conversation tab's pickers so both
// read as the same control.

interface Props {
  title: string;
  /** Shown when given; clears the selection. */
  onclear?: (() => void) | undefined;
  query: string;
  placeholder: string;
  align?: "start" | "center" | "end";
  children: Snippet;
}

let {
  title,
  onclear,
  query = $bindable(""),
  placeholder,
  align = "end",
  children,
}: Props = $props();
</script>

<Popover.Content {align} sideOffset={6} class="filter-popover">
	<div class="popover-header">
		<span class="popover-title">{title}</span>
		{#if onclear}
			<button type="button" class="popover-clear" onclick={onclear}>Clear</button>
		{/if}
	</div>
	<label class="filter-search">
		<MagnifyingGlass size={12} aria-hidden="true" />
		<input
			bind:value={query}
			type="search"
			{placeholder}
			aria-label={placeholder}
			spellcheck="false"
			autocomplete="off"
		/>
	</label>
	<!-- One scroll region for every section: scrolling carries past the first
	     section and on through the rest instead of trapping inside one list. -->
	<div class="filter-scroll">
		{@render children()}
	</div>
</Popover.Content>

<style>
	:global(.filter-popover) {
		width: min(260px, calc(var(--sidebar-width, 280px) - 24px));
		max-height: min(420px, calc(100vh - 180px));
		padding: 8px;
		gap: 8px;
	}

	.popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 2px 4px 4px;
	}

	.popover-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.popover-clear {
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.popover-clear:hover {
		color: var(--color-text-primary);
	}

	.filter-search {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr);
		align-items: center;
		gap: 6px;
		min-height: 28px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0 7px;
		background: var(--color-bg-secondary);
		color: var(--color-text-muted);
	}

	.filter-search:focus-within {
		border-color: var(--color-border-strong);
		color: var(--color-text-secondary);
	}

	.filter-search input {
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--color-text-primary);
		font-size: 11px;
		line-height: 1;
	}

	.filter-search input::placeholder {
		color: var(--color-text-muted);
	}

	.filter-scroll {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
</style>
