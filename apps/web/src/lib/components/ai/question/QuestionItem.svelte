<script lang="ts" module>
	import type { NormalizedQuestion } from "@revv/shared";

	export type QuestionItemProps = {
		question: NormalizedQuestion;
		index: number;
		total: number;
		selected: ReadonlySet<string>;
		customText: string;
		onToggleOption: (
			questionText: string,
			label: string,
			multiSelect: boolean,
		) => void;
		onCustomTextChange: (questionText: string, value: string) => void;
	};
</script>

<script lang="ts">
	import QuestionOption from "./QuestionOption.svelte";
	import QuestionCustomInput from "./QuestionCustomInput.svelte";

	let {
		question,
		index,
		total,
		selected,
		customText,
		onToggleOption,
		onCustomTextChange,
	}: QuestionItemProps = $props();
</script>

<div data-slot="question-item" class="flex flex-col gap-2">
	<div class="flex items-start gap-2">
		{#if total > 1}
			<span
				class="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground"
				aria-hidden="true"
			>
				{index + 1}
			</span>
		{/if}
		<div class="flex-1 min-w-0">
			<span class="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{question.header}
			</span>
			<p class="mt-1 text-sm leading-relaxed">{question.question}</p>
		</div>
	</div>

	<div class="flex flex-col gap-1.5">
		{#each question.options as option (option.label)}
			<QuestionOption
				{option}
				questionText={question.question}
				multiSelect={question.multiSelect}
				checked={selected.has(option.label)}
				onToggle={() =>
					onToggleOption(question.question, option.label, question.multiSelect)}
			/>
		{/each}
	</div>

	{#if question.allowCustom}
		<QuestionCustomInput
			value={customText}
			onInput={(v) => onCustomTextChange(question.question, v)}
		/>
	{/if}
</div>
