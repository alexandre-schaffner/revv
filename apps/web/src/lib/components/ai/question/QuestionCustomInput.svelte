<script lang="ts" module>
export type QuestionCustomInputProps = {
  value: string;
  onInput: (v: string) => void;
};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { Input } from "$lib/components/ui/input/index.js";
	import { QUESTION_CTX_KEY, type QuestionContext } from "./context.js";

	let { value, onInput }: QuestionCustomInputProps = $props();

	const ctx = getContext<QuestionContext>(QUESTION_CTX_KEY);
	const disabled = $derived(ctx.status !== "pending" || ctx.submitting);
</script>

<Input
	data-slot="question-custom-input"
	type="text"
	placeholder="Or write your own answer…"
	{value}
	{disabled}
	oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
	class="text-xs"
/>
