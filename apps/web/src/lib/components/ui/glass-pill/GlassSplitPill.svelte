<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import type { Snippet } from "svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import GlassPill from "./GlassPill.svelte";
import "./glass-pill.css";

// A GlassPill with a caret segment: the main segment runs the default action,
// the caret opens a menu of variants of it. One glass surface, two hit
// targets, a 1px seam between them. Without a `menu` it is a plain GlassPill,
// so a call site that only sometimes offers variants stays one element.

interface Props {
  disabled?: boolean;
  title?: string | undefined;
  onclick?: (() => void) | undefined;
  /** Accessible name for the caret segment. */
  menuLabel?: string;
  /** Main-segment content (icon + label). */
  children: Snippet;
  /** Menu rows. Receives `close` so a row can dismiss the menu. */
  menu?: Snippet<[close: () => void]> | undefined;
  menuClass?: string;
}

let {
  disabled = false,
  title,
  onclick,
  menuLabel = "More options",
  children,
  menu,
  menuClass = "w-72 gap-0.5 p-1",
}: Props = $props();

let open = $state(false);

function close(): void {
  open = false;
}
</script>

{#if menu}
	<span class="glass-surface glass-split" class:glass-split--disabled={disabled}>
		<button type="button" class="glass-split__main" {disabled} {title} {onclick}>
			{@render children()}
		</button>
		<PopoverRoot bind:open>
			<PopoverTrigger {disabled}>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class="glass-split__caret"
						aria-label={menuLabel}
						title={disabled ? title : menuLabel}
					>
						<CaretDown size={12} weight="bold" />
					</button>
				{/snippet}
			</PopoverTrigger>
			<PopoverContent class={menuClass} align="end" side="top">
				{@render menu(close)}
			</PopoverContent>
		</PopoverRoot>
	</span>
{:else}
	<GlassPill {disabled} {title} {onclick}>
		{@render children()}
	</GlassPill>
{/if}

<style>
	/* `.glass-surface` carries the glass; the segments are bare buttons that
	   carry their own hover, so there is nothing of `.glass-pill` to undo. */
	.glass-split {
		overflow: hidden;
	}

	.glass-split__main,
	.glass-split__caret {
		display: inline-flex;
		align-items: center;
		height: 100%;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		cursor: pointer;
	}
	.glass-split__main {
		gap: 8px;
		padding: 0 12px 0 16px;
	}
	.glass-split__caret {
		justify-content: center;
		width: 30px;
		padding-right: 2px;
		border-left: 1px solid var(--color-glass-border);
		color: var(--color-text-secondary);
	}

	.glass-split__main:hover:not(:disabled),
	.glass-split__caret:hover:not(:disabled),
	.glass-split__caret[data-state="open"] {
		background: color-mix(in srgb, var(--color-tab-active-bg) 80%, var(--color-tab-track-bg));
	}
	.glass-split__main:active:not(:disabled),
	.glass-split__caret:active:not(:disabled) {
		background: var(--color-tab-active-bg);
	}

	.glass-split__main:focus-visible,
	.glass-split__caret:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
	.glass-split__main:focus-visible {
		border-radius: 9999px 0 0 9999px;
	}
	.glass-split__caret:focus-visible {
		border-radius: 0 9999px 9999px 0;
	}

	/* A span can't match `:disabled`, so the wrapper mirrors the buttons. */
	.glass-split--disabled {
		opacity: 0.4;
	}
	.glass-split--disabled button {
		cursor: not-allowed;
	}
</style>
