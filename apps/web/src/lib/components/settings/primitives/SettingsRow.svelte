<script lang="ts">
/*
 * One setting. The control vocabulary is fixed; pick by the shape of the value:
 *
 *   boolean                  → Switch
 *   2–4 fixed options        → SegmentedControl
 *   5+ or dynamic options    → Select, always `w-48`
 *   bounded integer          → Stepper
 *   free text                → CommitInput (commits on blur / Enter, Esc reverts)
 *   action                   → trailing `outline` / `secondary` Button, `size="sm"`
 *
 * `id` is the search anchor: it must match an entry in `settings-index.ts`, so
 * a search hit can scroll to this row and flash it.
 */
import type { Snippet } from "svelte";

interface Props {
  id: string;
  label: string;
  /** Plain text, or a snippet when the hint needs a link or inline code. */
  hint?: string | Snippet | undefined;
  /** Associates the label with a form control (for inputs, not switches). */
  labelFor?: string;
  disabled?: boolean;
  /** `inline` puts the control beside the label; `stacked` puts it below, full width. */
  layout?: "inline" | "stacked";
  /** Content before the label: an avatar or an identifying icon. */
  leading?: Snippet;
  control?: Snippet;
  /** Expanded content under the row: status panels, install logs. */
  children?: Snippet;
}

let {
  id,
  label,
  hint,
  labelFor,
  disabled = false,
  layout = "inline",
  leading,
  control,
  children,
}: Props = $props();
</script>

<div
	class="row"
	class:row--stacked={layout === 'stacked'}
	class:row--disabled={disabled}
	data-setting-id={id}
	aria-disabled={disabled || undefined}
>
	<div class="row-main">
		{#if leading}
			<div class="row-leading">{@render leading()}</div>
		{/if}
		<div class="row-info">
			{#if labelFor}
				<label class="row-label" for={labelFor}>{label}</label>
			{:else}
				<p class="row-label">{label}</p>
			{/if}
			{#if typeof hint === 'string'}
				<p class="row-hint">{hint}</p>
			{:else if hint}
				<p class="row-hint">{@render hint()}</p>
			{/if}
		</div>
		{#if control}
			<div class="row-control">{@render control()}</div>
		{/if}
	</div>
	{#if children}
		<div class="row-extra">{@render children()}</div>
	{/if}
</div>

<style>
	.row {
		--setting-flash: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px 16px;
		background-color: color-mix(
			in srgb,
			var(--color-accent) calc(var(--setting-flash) * 14%),
			transparent
		);
	}

	.row-main {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 30px;
	}

	.row--stacked .row-main {
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
	}

	.row--disabled .row-info {
		opacity: 0.55;
	}

	.row-leading {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		margin-right: -4px;
	}

	.row-info {
		min-width: 0;
		flex: 1;
	}

	.row-label {
		display: block;
		font-size: 13px;
		line-height: 1.35;
		color: var(--color-text-primary);
		overflow-wrap: anywhere;
	}

	.row-hint {
		margin-top: 3px;
		max-width: 60ch;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.row-hint :global(code) {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11.5px;
	}

	.row-hint :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.row-control {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 8px;
	}

	.row--stacked .row-control {
		flex-shrink: 1;
	}

	.row-extra {
		min-width: 0;
	}
</style>
