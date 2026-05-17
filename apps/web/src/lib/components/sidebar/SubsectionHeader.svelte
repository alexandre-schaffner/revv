<script lang="ts">
import type { Component, Snippet } from "svelte";
import { getFocusedId } from "$lib/stores/sidebar-nav.svelte";

interface Props {
  /** Lucide icon component rendered before the label. */
  icon: Component<{ size?: number; class?: string }>;
  label: string;
  count?: number | null;
  expanded: boolean;
  onToggle: () => void;
  /** Stable id used for vim-nav focus + parent linkage. */
  navId: string;
  /** Parent nav id (the repo) — drives `h` collapse traversal. */
  navParent?: string;
  /** Optional right-aligned action (e.g. generate popover trigger). */
  action?: Snippet;
}

let { icon: Icon, label, count, expanded, onToggle, navId, navParent, action }: Props = $props();

const isFocused = $derived(getFocusedId() === navId);
</script>

<div class="row {isFocused ? 'sidebar-nav-focused' : ''}">
	<button
		class="header"
		onclick={onToggle}
		aria-label="Toggle {label}"
		aria-expanded={expanded}
		data-sidebar-nav={navId}
		data-nav-type="dir"
		data-nav-expanded={expanded}
		data-nav-parent={navParent ?? null}
	>
		<svg
			class="chevron h-3 w-3 shrink-0 text-text-muted transition-transform duration-snap ease-out-expo {expanded ? 'rotate-90' : ''}"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
		<Icon size={11} class="shrink-0 text-text-muted" />
		<span class="label">{label}</span>
		{#if count != null}
			<span class="count">{count}</span>
		{/if}
	</button>
	{#if action}
		<div class="action">
			{@render action()}
		</div>
	{/if}
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		width: 100%;
		padding-right: 6px;
	}
	.row.sidebar-nav-focused {
		background: var(--color-bg-tertiary);
		box-shadow: inset 2px 0 0 var(--color-accent);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 5px;
		flex: 1;
		min-width: 0;
		padding: 4px 6px 4px 12px;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
	}
	.header:hover {
		color: var(--color-text-secondary);
	}
	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		margin-left: auto;
		border-radius: 9999px;
		background: var(--color-bg-elevated);
		padding: 0 6px;
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: var(--color-text-muted);
	}
	.action {
		display: inline-flex;
		align-items: center;
	}
</style>
