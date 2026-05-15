<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type QuestionHeaderProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import {
		Check,
		Clock,
		ShieldX,
	} from "@lucide/svelte";
	import type { Component } from "svelte";
	import { cn } from "$lib/utils.js";
	import { QUESTION_CTX_KEY, type QuestionContext } from "./context.js";

	let { class: className, children, ...restProps }: QuestionHeaderProps = $props();

	const ctx = getContext<QuestionContext>(QUESTION_CTX_KEY);

	// Status badge dispatch — same shape as ai/tool/ToolHeader (intentionally
	// co-located rather than abstracted; the two share visual language but
	// different label sets).
	type BadgeConfig = {
		readonly label: string;
		readonly icon: Component;
		readonly tone:
			| "answered"
			| "rejected"
			| "superseded";
	};
	const config: Record<Exclude<QuestionContext["status"], "pending">, BadgeConfig> = {
		answered: { label: "Answered", icon: Check, tone: "answered" },
		rejected: { label: "Skipped", icon: ShieldX, tone: "rejected" },
		superseded: {
			label: "No longer needed",
			icon: Clock,
			tone: "superseded",
		},
	};

	const c = $derived(ctx.status !== "pending" ? config[ctx.status] : undefined);
	const Icon = $derived(c?.icon);
</script>

<div
	data-slot="question-header"
	class={cn(
		"flex items-center justify-between gap-2 px-4 pt-3 pb-2",
		className,
	)}
	{...restProps}
>
	<h4 class="text-sm font-semibold">Question</h4>
	{#if c && Icon}
		<span
			class={cn(
				"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wider",
			c.tone === "answered" &&
				"bg-success/15 text-success",
				c.tone === "rejected" &&
					"bg-destructive/15 text-destructive",
				c.tone === "superseded" &&
					"bg-muted text-muted-foreground",
			)}
		>
			<Icon class="size-2.5" />
			{c.label}
		</span>
	{/if}
	{@render children?.()}
</div>
