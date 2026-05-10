<script lang="ts">
	import AddRepoForm from './AddRepoForm.svelte';

	let { open = false, onClose }: { open?: boolean; onClose: () => void } = $props();
</script>

{#if open}
	<!-- Backdrop -->
	<div class="fixed inset-0 z-40 bg-black/60" role="presentation" onclick={onClose}></div>

	<!-- Dialog -->
	<div
		class="fixed left-1/2 top-1/2 z-50 flex w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-secondary p-5 shadow-2xl"
		style="max-height: min(560px, 80vh)"
		role="dialog"
		aria-modal="true"
		aria-label="Add repository"
	>
		<AddRepoForm {onClose} />
	</div>
{/if}
