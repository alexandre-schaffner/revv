<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { NormalizedQuestion } from "@revv/shared";
	import type { QuestionStatus } from "./context.js";

	export type QuestionProps = HTMLAttributes<HTMLDivElement> & {
		prId: string;
		itemId: string;
		questions: ReadonlyArray<NormalizedQuestion>;
		status: QuestionStatus;
		answers: Readonly<Record<string, ReadonlyArray<string>>> | null;
		customAnswers: Readonly<Record<string, string>> | null;
		previewFormat: "markdown" | "html";
	};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { fly } from "svelte/transition";
	import { cubicOut } from "svelte/easing";
	import { cn } from "$lib/utils.js";
	import {
		isSubmittingQuestion,
		submitQuestionAnswers,
	} from "$lib/stores/chat.svelte";
	import QuestionHeader from "./QuestionHeader.svelte";
	import QuestionList from "./QuestionList.svelte";
	import QuestionFooter from "./QuestionFooter.svelte";
	import QuestionAnsweredSummary from "./QuestionAnsweredSummary.svelte";
	import { QUESTION_CTX_KEY, type QuestionContext } from "./context.js";

	let {
		prId,
		itemId,
		questions,
		status,
		answers,
		customAnswers,
		previewFormat,
		class: className,
		...restProps
	}: QuestionProps = $props();

	// Per-question selection (label set) + free-text capture. Initialized
	// from the persisted answers so a remount after answer mirrors what the
	// server has, not a blank slate.
	const initialSelections = (): Record<string, Set<string>> => {
		const out: Record<string, Set<string>> = {};
		for (const q of questions) {
			out[q.question] = new Set<string>(answers?.[q.question] ?? []);
		}
		return out;
	};
	const initialCustom = (): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const q of questions) {
			out[q.question] = customAnswers?.[q.question] ?? "";
		}
		return out;
	};
	let selections = $state<Record<string, Set<string>>>(initialSelections());
	let customText = $state<Record<string, string>>(initialCustom());

	const submitting = $derived(isSubmittingQuestion(itemId));

	// Gate: every question must contribute at least one selection OR (when
	// allowCustom) a non-empty free-text entry. Empty answers are refused
	// client-side so the user has to make a choice before submit.
	const canSubmit = $derived(
		status === "pending" &&
			!submitting &&
			questions.every((q) => {
				const picked = selections[q.question]?.size ?? 0;
				const customFilled =
					q.allowCustom && (customText[q.question] ?? "").trim().length > 0;
				return picked > 0 || customFilled;
			}),
	);

	const ctx: QuestionContext = {
		get status() {
			return status;
		},
		get submitting() {
			return submitting;
		},
		get previewFormat() {
			return previewFormat;
		},
	};
	setContext(QUESTION_CTX_KEY, ctx);

	function toggleOption(
		questionText: string,
		label: string,
		multiSelect: boolean,
	): void {
		const current = selections[questionText] ?? new Set<string>();
		const next = new Set(current);
		if (multiSelect) {
			if (next.has(label)) {
				next.delete(label);
			} else {
				next.add(label);
			}
		} else {
			if (next.has(label) && next.size === 1) {
				// Allow deselecting in single-select mode by tapping the active
				// option — Submit will stay disabled until a different option
				// is picked, matching radio-group conventions where
				// "no choice yet" is a valid intermediate state.
				next.clear();
			} else {
				next.clear();
				next.add(label);
			}
		}
		selections[questionText] = next;
	}

	function setCustomText(questionText: string, value: string): void {
		customText[questionText] = value;
	}

	function submit(): void {
		if (!canSubmit) return;
		const answersPayload: Record<string, string[]> = {};
		const customPayload: Record<string, string> = {};
		for (const q of questions) {
			answersPayload[q.question] = Array.from(
				selections[q.question] ?? new Set<string>(),
			);
			const ct = (customText[q.question] ?? "").trim();
			if (ct.length > 0) customPayload[q.question] = ct;
		}
		void submitQuestionAnswers(prId, itemId, {
			decision: "answer",
			answers: answersPayload,
			...(Object.keys(customPayload).length > 0
				? { customAnswers: customPayload }
				: {}),
		});
	}

	function skip(): void {
		void submitQuestionAnswers(prId, itemId, { decision: "reject" });
	}
</script>

<div
	data-slot="question"
	class={cn(
		"rounded-lg border border-border bg-background shadow-xs transition-colors duration-snap",
		status === "answered" && "border-green-500/35",
		status === "rejected" && "border-destructive/35 opacity-90",
		status === "superseded" && "opacity-60",
		className,
	)}
	in:fly={{ y: 8, duration: 220, easing: cubicOut }}
	{...restProps}
>
	<QuestionHeader />

	{#if status === "pending"}
		<QuestionList
			{questions}
			{selections}
			{customText}
			onToggleOption={toggleOption}
			onCustomTextChange={setCustomText}
		/>
		<QuestionFooter onSubmit={submit} onSkip={skip} {canSubmit} {submitting} />
	{:else}
		<QuestionAnsweredSummary
			{questions}
			{status}
			answers={answers ?? {}}
			customAnswers={customAnswers ?? null}
		/>
	{/if}
</div>
