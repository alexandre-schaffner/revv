<script lang="ts">
interface Props {
  title: string;
  meta?: string | undefined;
}

let { title, meta }: Props = $props();
</script>

<div class="form-header">
	<h2 class="title">{title}</h2>
	{#if meta}
		<span class="title-meta">{meta}</span>
	{/if}
</div>

<style>
	.form-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
		flex-shrink: 0;
	}

	.title {
		margin: 0;
		color: var(--color-text-primary);
		font-size: var(--text-sm);
		font-weight: 500;
		letter-spacing: var(--text-sm--letter-spacing);
	}

	.title-meta {
		color: var(--color-text-muted);
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		font-variant-numeric: tabular-nums;
	}
</style>
