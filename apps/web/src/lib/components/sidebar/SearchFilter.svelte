<script lang="ts">
import { setSearchQuery } from "$lib/stores/prs.svelte";
import {
  expandOrSelect,
  getFocusedId,
  moveDown,
  moveUp,
  setFocusedId,
} from "$lib/stores/sidebar-nav.svelte";

let { onAddRepo }: { onAddRepo: () => void } = $props();

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

// Repo groups default to collapsed, so on a fresh search the only
// data-sidebar-nav nodes in the PR pane are the repo headers. We
// land the highlight on an actual PR row (data-nav-type="pr"); if
// none are mounted because every group is closed, we click the
// first repo header to expand it and walk the DOM again on the next
// frame.
function highlightFirstPr(): boolean {
  const pr = document.querySelector<HTMLElement>('.view-pane--prs [data-nav-type="pr"]');
  const id = pr?.getAttribute("data-sidebar-nav");
  if (!id) return false;
  setFocusedId(id);
  return true;
}

function jumpToFirstResult(): void {
  if (highlightFirstPr()) return;
  const firstGroup = document.querySelector<HTMLElement>('.view-pane--prs [data-nav-type="repo"]');
  if (!firstGroup) return;
  firstGroup.click();
  requestAnimationFrame(() => {
    highlightFirstPr();
  });
}

// Returns whether the currently-focused sidebar-nav id still points
// at a rendered DOM node — i.e. the keyboard cursor is on something
// real that moveDown/moveUp can step from. False on the very first
// arrow press, and false again if the active query filtered the
// focused PR out.
function focusedItemRendered(): boolean {
  const id = getFocusedId();
  if (!id) return false;
  return document.querySelector(`[data-sidebar-nav="${CSS.escape(id)}"]`) !== null;
}

// Keyboard nav from the search input.
//
// First press lands the cursor on the first matching PR (auto-
// expanding the lead repo group if needed). Subsequent presses step
// through the list via the shared sidebar-nav store, so DOM focus
// stays on the input — the user can keep typing while navigating.
// Enter activates whatever the cursor is on (selects the PR via the
// nav-store's expandOrSelect, which clicks the focused button).
function handleKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();

  if (e.key === "Enter") {
    if (focusedItemRendered()) {
      expandOrSelect();
    } else {
      flushSearch();
      requestAnimationFrame(jumpToFirstResult);
    }
    inputEl?.blur();
    return;
  }

  if (focusedItemRendered()) {
    if (e.key === "ArrowDown") moveDown();
    else if (e.key === "ArrowUp") moveUp();
    return;
  }

  // ArrowUp from a fresh state has nowhere to go — don't surprise
  // the user by jumping into the list from below.
  if (e.key === "ArrowUp") return;

  flushSearch();
  requestAnimationFrame(jumpToFirstResult);
}

function handleClear() {
  inputValue = "";
  setSearchQuery("");
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
			bind:this={inputEl}
			class="h-7 w-full rounded-lg border border-border bg-bg-elevated pl-8 pr-7 text-xs text-text-primary placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
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
