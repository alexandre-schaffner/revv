<script lang="ts" module>
import type { NormalizedQuestionOption } from "@revv/shared";

export type QuestionOptionProps = {
  option: NormalizedQuestionOption;
  questionText: string;
  multiSelect: boolean;
  checked: boolean;
  onToggle: () => void;
};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { renderMarkdown } from "$lib/utils/markdown";
	import { QUESTION_CTX_KEY, type QuestionContext } from "./context.js";

	let {
		option,
		questionText,
		multiSelect,
		checked,
		onToggle,
	}: QuestionOptionProps = $props();

	const ctx = getContext<QuestionContext>(QUESTION_CTX_KEY);
	const disabled = $derived(ctx.status !== "pending" || ctx.submitting);

	const previewHtml = $derived.by(() => {
		if (!option.preview) return null;
		// Claude can request `previewFormat: 'html'` if Revv ever opts in,
		// but the chat MCP requests `markdown`, so we treat the value as
		// markdown and render it through our existing pipeline. When the
		// format is explicitly `html`, we pass it through verbatim (the
		// agent has already produced safe HTML per the SDK schema).
		return ctx.previewFormat === "html"
			? option.preview
			: renderMarkdown(option.preview);
	});

	let detailsOpen = $state(false);

	function handleClick(): void {
		if (disabled) return;
		onToggle();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (disabled) return;
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			onToggle();
		}
	}
</script>

<div
	data-slot="question-option"
	class={cn(
		"flex flex-col gap-1 rounded-md border px-3 py-2 transition-colors duration-snap",
		checked
			? "border-accent bg-accent/10"
			: "border-border bg-background hover:bg-muted/40",
		disabled && "opacity-60 cursor-not-allowed",
	)}
>
	<button
		type="button"
		class="flex w-full items-start gap-2 text-left"
		role={multiSelect ? "checkbox" : "radio"}
		aria-checked={checked}
		aria-label={`${option.label}: ${option.description}`}
		aria-disabled={disabled}
		{disabled}
		onclick={handleClick}
		onkeydown={handleKeydown}
	>
		<span
			class={cn(
				"mt-0.5 inline-flex shrink-0 items-center justify-center border border-input bg-background",
				multiSelect
					? "size-4 rounded-sm"
					: "size-4 rounded-full",
				checked && "border-accent bg-accent text-white",
			)}
			aria-hidden="true"
		>
			{#if checked}
				{#if multiSelect}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="3"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="size-3"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				{:else}
					<span class="size-1.5 rounded-full bg-white"></span>
				{/if}
			{/if}
		</span>
		<span class="flex-1 min-w-0">
			<span class="block text-sm font-medium">{option.label}</span>
			{#if option.description}
				<span class="block text-xs text-muted-foreground"
					>{option.description}</span
				>
			{/if}
		</span>
	</button>

	{#if previewHtml}
		<details
			class="ml-6 text-xs"
			bind:open={detailsOpen}
			ondblclick={(e) => e.stopPropagation()}
		>
			<summary
				class="cursor-pointer select-none text-muted-foreground hover:text-foreground"
			>
				{detailsOpen ? "Hide" : "Show"} preview
			</summary>
			<div
				class="mt-1.5 rounded bg-muted/60 p-2 text-xs leading-relaxed [&_pre]:overflow-x-auto"
			>
				{@html previewHtml}
			</div>
		</details>
	{/if}
</div>
