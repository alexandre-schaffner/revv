<script lang="ts" module>
export type QuestionFooterProps = {
  onSubmit: () => void;
  onSkip: () => void;
  canSubmit: boolean;
  submitting: boolean;
};
</script>

<script lang="ts">
	import { Check, Loader2, X } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button/index.js";

	let { onSubmit, onSkip, canSubmit, submitting }: QuestionFooterProps =
		$props();
</script>

<div
	data-slot="question-footer"
	class="flex items-center justify-end gap-2 border-t border-border px-4 py-2"
>
	<Button
		variant="ghost"
		size="sm"
		onclick={onSkip}
		disabled={submitting}
	>
		<X data-icon="inline-start" />
		Skip
	</Button>
	<Button size="sm" onclick={onSubmit} disabled={!canSubmit}>
		{#if submitting}
			<Loader2 data-icon="inline-start" class="motion-essential-spin animate-spin" />
			Submitting…
		{:else}
			<Check data-icon="inline-start" />
			Submit answer
		{/if}
	</Button>
</div>
