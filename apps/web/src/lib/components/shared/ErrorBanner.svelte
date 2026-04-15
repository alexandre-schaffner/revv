<script lang="ts">
	import * as errors from '$lib/stores/errors.svelte';

	function formatCountdown(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}
</script>

{#if errors.getError()}
	<div
		class="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
	>
		<span class="flex-1">
			{errors.getError()?.message}
			{#if errors.getCountdown() > 0}
				<span class="text-text-muted ml-1">(retry in {formatCountdown(errors.getCountdown())})</span>
			{/if}
		</span>
		<button
			class="shrink-0 text-text-muted hover:text-text-secondary transition-colors"
			onclick={() => errors.clearError()}
			aria-label="Dismiss error"
		>
			✕
		</button>
	</div>
{/if}
