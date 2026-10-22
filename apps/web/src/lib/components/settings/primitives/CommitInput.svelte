<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import { Input } from "$lib/components/ui/input";
import { gsapFade } from "$lib/motion";
import { cn } from "$lib/utils.js";

// A text field that holds a local draft and writes it back once: on blur or
// Enter. Esc reverts the draft (and only then swallows the key, so an
// untouched field still lets Esc close the dialog). A successful commit
// flashes a quiet "Saved" so a blur-to-save field doesn't feel like a no-op.

interface Props {
  id: string;
  value: string;
  onCommit: (value: string) => void | Promise<void>;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  class?: string;
}

let {
  id,
  value,
  onCommit,
  placeholder,
  mono = false,
  disabled = false,
  class: className,
}: Props = $props();

const SAVED_HOLD_MS = 1600;

let draft = $state("");
/** Plain, not `$state`: the sync effect below must not re-run on blur. */
let focused = false;
let saved = $state(false);
let savedTimer: ReturnType<typeof setTimeout> | null = null;

// Follow the committed value while the user isn't editing, so a change from
// elsewhere (another window, a server reconcile) lands in the field.
$effect.pre(() => {
  const next = value;
  if (!focused) draft = next;
});

$effect(() => () => {
  if (savedTimer) clearTimeout(savedTimer);
});

async function commit(): Promise<void> {
  if (draft === value) return;
  await onCommit(draft);
  saved = true;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    saved = false;
  }, SAVED_HOLD_MS);
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    void commit();
  } else if (e.key === "Escape" && draft !== value) {
    e.stopPropagation();
    draft = value;
  }
}
</script>

<div class="commit-input">
	<Input
		{id}
		type="text"
		{placeholder}
		{disabled}
		spellcheck="false"
		autocomplete="off"
		class={cn(mono && 'font-mono', className)}
		bind:value={draft}
		onfocus={() => (focused = true)}
		onblur={() => {
			focused = false;
			void commit();
		}}
		onkeydown={handleKeydown}
	/>
	<span class="commit-status" aria-live="polite">
		{#if saved}
			<span class="commit-saved" transition:gsapFade>
				<Check size={12} />
				Saved
			</span>
		{/if}
	</span>
</div>

<style>
	.commit-input {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
	}

	.commit-status {
		display: inline-flex;
		flex-shrink: 0;
		width: 52px;
	}

	.commit-saved {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}
</style>
