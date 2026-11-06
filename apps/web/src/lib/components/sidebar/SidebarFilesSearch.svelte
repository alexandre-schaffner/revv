<script lang="ts">
import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
import X from "phosphor-svelte/lib/X";
import { untrack } from "svelte";
import { getFileSearchQuery, setFileSearchQuery } from "$lib/stores/sidebar.svelte";

interface Props {
  /** Enter / ArrowDown: the query is applied; move on to the results. */
  onSubmit: (query: string) => void;
}

let { onSubmit }: Props = $props();

// Mirror SearchFilter.svelte's input UX: 300ms debounce so we don't thrash
// the tree's setSearch on every keystroke.
let inputEl: HTMLInputElement;
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

function flushSearch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  setFileSearchQuery(inputValue);
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== "ArrowDown") return;
  e.preventDefault();
  flushSearch();
  inputEl?.blur();
  onSubmit(inputValue);
}

/** Focus the field and select its text (the sidebar's `/` shortcut). */
export function focus(): void {
  inputEl?.focus();
  inputEl?.select();
}

function handleClear() {
  inputValue = "";
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  setFileSearchQuery("");
}
</script>

<div class="flex items-center gap-1.5 px-3 py-2">
	<div class="relative flex-1">
		<MagnifyingGlass
			class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
		/>
		<input
			bind:this={inputEl}
			class="h-7 w-full rounded-full border border-border bg-bg-elevated pl-8 pr-7 text-xs text-text-primary placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
			placeholder="Search files..."
			aria-label="Search files"
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
</div>
