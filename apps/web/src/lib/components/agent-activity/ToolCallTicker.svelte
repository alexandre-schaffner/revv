<script lang="ts">
/**
 * The live agent's latest tool calls as a fixed-height stack of rows: a new
 * row flies up from below, the oldest flies out the top. Font size comes from
 * the parent; the row height is fixed so the stack never shifts layout.
 */
import { gsapFadeY, tokens } from "$lib/motion";

interface TickerRow {
  readonly key: string | number;
  /** The accent lead: a tool name, or a placeholder verb. */
  readonly label: string;
  /** Muted, truncated text after the label. */
  readonly detail?: string;
}

interface Props {
  rows: readonly TickerRow[];
  /** How many rows the ticker is tall. */
  lines?: number;
}

let { rows, lines = 2 }: Props = $props();

const ROW_H = 14;
</script>

<div class="ticker" style:height="{lines * ROW_H}px">
	{#each rows as row, i (row.key)}
		<div
			class="ticker-row"
			style:top="{i * ROW_H}px"
			in:gsapFadeY={{ y: ROW_H, duration: tokens.smooth }}
			out:gsapFadeY={{ y: -ROW_H, duration: tokens.quick }}
		>
			<span class="ticker-label">{row.label}</span>
			{#if row.detail}
				<span class="ticker-detail">{row.detail}</span>
			{/if}
		</div>
	{/each}
</div>

<style>
	.ticker {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}

	.ticker-row {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		gap: 6px;
		min-width: 0;
		line-height: 14px;
		/* `top`, not a transform: the enter transition writes an inline
		   `transform`, and a base-class transform would compose with it. */
		transition: top var(--duration-smooth) var(--ease-standard);
	}

	.ticker-label {
		flex-shrink: 0;
		white-space: nowrap;
		color: var(--color-accent);
		font-weight: 500;
	}

	.ticker-detail {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-muted);
	}
</style>
