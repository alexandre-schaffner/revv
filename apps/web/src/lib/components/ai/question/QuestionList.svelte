<script lang="ts" module>
	import type { NormalizedQuestion } from "@revv/shared";

	export type QuestionListProps = {
		questions: ReadonlyArray<NormalizedQuestion>;
		selections: Record<string, Set<string>>;
		customText: Record<string, string>;
		onToggleOption: (
			questionText: string,
			label: string,
			multiSelect: boolean,
		) => void;
		onCustomTextChange: (questionText: string, value: string) => void;
	};
</script>

<script lang="ts">
	import QuestionItem from "./QuestionItem.svelte";

	let {
		questions,
		selections,
		customText,
		onToggleOption,
		onCustomTextChange,
	}: QuestionListProps = $props();
</script>

<div data-slot="question-list" class="flex flex-col gap-4 px-4 pb-3">
	{#each questions as q, idx (q.question)}
		<QuestionItem
			question={q}
			index={idx}
			total={questions.length}
			selected={selections[q.question] ?? new Set()}
			customText={customText[q.question] ?? ""}
			{onToggleOption}
			{onCustomTextChange}
		/>
	{/each}
</div>
