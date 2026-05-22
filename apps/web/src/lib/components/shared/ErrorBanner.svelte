<script lang="ts">
import X from "phosphor-svelte/lib/X";
import { clearError, getCountdown, getError } from "$lib/stores/errors.svelte";

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
</script>

{#if getError()}
	<div
		class="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
	>
		<span class="flex-1">
			{getError()?.message}
			{#if getCountdown() > 0}
				<span class="text-text-muted ml-1">(retry in {formatCountdown(getCountdown())})</span>
			{/if}
		</span>
		<button
			class="shrink-0 text-text-muted hover:text-text-secondary transition-colors"
			onclick={() => clearError()}
			aria-label="Dismiss error"
		>
			<X size={14} weight="fill" />
		</button>
	</div>
{/if}
