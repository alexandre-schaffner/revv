<script lang="ts">
import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
import X from "phosphor-svelte/lib/X";
import type { Snippet } from "svelte";
import { setSearchQuery } from "$lib/stores/prs.svelte";
import {
  focusFirst,
  isFocusedVisible,
  moveDown,
  moveUp,
  openFocused,
} from "$lib/stores/sidebar-nav.svelte";

interface Props {
  /** Inline to the right of the input — the creator filter button. */
  trailing?: Snippet;
}

let { trailing }: Props = $props();

let inputEl: HTMLInputElement;
let inputValue = $state("");
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

// Keyboard nav from the search input. The first press lands the cursor on
// the first matching PR; later presses step through the list, so DOM focus
// stays on the input and the user can keep typing. Enter opens whatever the
// cursor is on.
function handleKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();

  if (e.key === "Enter") {
    if (isFocusedVisible()) {
      openFocused();
    } else {
      flushSearch();
      focusFirst();
    }
    inputEl?.blur();
    return;
  }

  if (isFocusedVisible()) {
    if (e.key === "ArrowDown") moveDown();
    else moveUp();
    return;
  }

  // ArrowUp from a fresh state has nowhere to go — don't surprise
  // the user by jumping into the list from below.
  if (e.key === "ArrowUp") return;

  flushSearch();
  focusFirst();
}

/** Focus the field and select its text (the sidebar's `/` shortcut). */
export function focus(): void {
  inputEl?.focus();
  inputEl?.select();
}

function handleClear() {
  inputValue = "";
  setSearchQuery("");
}
</script>

<style>
	.search-container {
		display: flex;
		align-items: center;
		gap: var(--spacing-island);
		padding: var(--spacing-island) var(--spacing-inset);
	}
</style>

<div class="search-container">
	<div class="relative flex-1">
		<MagnifyingGlass
			class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
		/>
		<input
			bind:this={inputEl}
			class="h-7 w-full rounded-full border border-border bg-bg-elevated pl-8 pr-7 text-xs text-text-primary placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
			placeholder="Search PRs..."
			aria-label="Search pull requests"
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
				<X class="h-3 w-3" />
			</button>
		{/if}
	</div>
	{@render trailing?.()}
</div>
