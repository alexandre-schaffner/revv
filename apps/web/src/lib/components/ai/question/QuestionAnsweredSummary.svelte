<script lang="ts" module>
import type { NormalizedQuestion } from "@revv/shared";
import type { QuestionStatus } from "./context.js";

export type QuestionAnsweredSummaryProps = {
  questions: ReadonlyArray<NormalizedQuestion>;
  status: Exclude<QuestionStatus, "pending">;
  answers: Readonly<Record<string, ReadonlyArray<string>>>;
  customAnswers: Readonly<Record<string, string>> | null;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		questions,
		status,
		answers,
		customAnswers,
	}: QuestionAnsweredSummaryProps = $props();
</script>

<div
	data-slot="question-answered-summary"
	class="flex flex-col gap-3 px-4 pb-3 text-sm"
>
	{#each questions as q (q.question)}
		{@const picked = answers[q.question] ?? []}
		{@const custom = customAnswers?.[q.question] ?? ""}
		<div class="flex flex-col gap-1">
			<span class="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{q.header}
			</span>
			<p
				class={cn(
					"text-xs leading-relaxed text-muted-foreground",
					status === "rejected" && "line-through",
				)}
			>
				{q.question}
			</p>
			{#if status === "rejected"}
				<span class="text-xs italic text-muted-foreground">Skipped</span>
			{:else if status === "superseded"}
				<span class="text-xs italic text-muted-foreground"
					>No longer needed.</span
				>
			{:else}
				<div class="flex flex-wrap gap-1.5">
					{#each picked as label (label)}
						<span
							class="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
						>
							{label}
						</span>
					{/each}
					{#if picked.length === 0 && !custom}
						<span class="text-xs italic text-muted-foreground"
							>(no choice recorded)</span
						>
					{/if}
				</div>
				{#if custom}
					<p class="text-xs text-muted-foreground">
						<span class="font-medium">Custom:</span>
						{custom}
					</p>
				{/if}
			{/if}
		</div>
	{/each}
</div>
