<script lang="ts">
// A status is never color alone: the dot always travels with its text, either
// rendered beside it or carried as the accessible name when space is tight.

interface Props {
  tone: "success" | "warning" | "danger" | "muted";
  label: string;
  /** Render the label as visible text. When false it becomes the aria-label. */
  showLabel?: boolean;
}

let { tone, label, showLabel = true }: Props = $props();
</script>

{#if showLabel}
	<span class="status">
		<span class="dot dot--{tone}" aria-hidden="true"></span>
		<span class="status-text">{label}</span>
	</span>
{:else}
	<span class="dot dot--{tone}" role="img" aria-label={label} title={label}></span>
{/if}

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.status-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.dot {
		display: inline-block;
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.dot--success {
		background: var(--color-success);
	}

	.dot--warning {
		background: var(--color-warning);
	}

	.dot--danger {
		background: var(--color-danger);
	}

	.dot--muted {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--color-text-muted);
	}
</style>
