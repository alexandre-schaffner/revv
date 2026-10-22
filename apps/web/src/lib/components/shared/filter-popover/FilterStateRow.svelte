<script lang="ts">
import Spinner from "phosphor-svelte/lib/Spinner";

/** A non-option row in a filter popover: loading, empty, or failed with a retry. */
interface Props {
  message: string;
  loading?: boolean;
  /** Turns the row into a button with this action label. */
  action?: { readonly label: string; readonly run: () => void } | undefined;
}

let { message, loading = false, action }: Props = $props();
</script>

{#if action}
	<button type="button" class="state-row state-row--button" onclick={action.run}>
		<span>{message}</span>
		<span class="state-action">{action.label}</span>
	</button>
{:else}
	<div class="state-row">
		{#if loading}<Spinner size={12} class="motion-essential-spin" aria-hidden="true" />{/if}
		<span>{message}</span>
	</div>
{/if}

<style>
	.state-row {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 30px;
		padding: 4px 6px 4px 21px;
		border-radius: 6px;
		color: var(--color-text-muted);
		font-size: 11px;
		text-align: left;
	}

	.state-row--button {
		width: 100%;
		justify-content: space-between;
	}

	.state-row--button:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.state-action {
		color: var(--color-accent);
		font-weight: 600;
	}
</style>
