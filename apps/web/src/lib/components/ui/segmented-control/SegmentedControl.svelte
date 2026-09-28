<script lang="ts" module>
import type { Component } from "svelte";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: Component<{ size?: number | string }>;
}
</script>

<script lang="ts" generics="T extends string">
import { RadioGroup } from "bits-ui";
import { cn } from "$lib/utils.js";

// A 2–4 option single choice, drawn as the DESIGN.md pill track (the PR tab
// idiom): inactive segments sit on a faint ink track, the active one steps up
// to warm paper with the Indicator shadow. bits-ui's RadioGroup supplies
// `role="radiogroup"`, `aria-checked`, and arrow-key roving.

interface Props {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  "aria-label": string;
  disabled?: boolean;
  class?: string;
}

let {
  options,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  disabled = false,
  class: className,
}: Props = $props();

function handleChange(next: string): void {
  const match = options.find((o) => o.value === next);
  if (match && match.value !== value) onValueChange(match.value);
}
</script>

<RadioGroup.Root
	{value}
	onValueChange={handleChange}
	orientation="horizontal"
	loop
	{disabled}
	aria-label={ariaLabel}
	class={cn("segmented", className)}
>
	{#each options as option (option.value)}
		<RadioGroup.Item value={option.value} class="segmented-item">
			{#if option.icon}
				<option.icon size={13} />
			{/if}
			<span>{option.label}</span>
		</RadioGroup.Item>
	{/each}
</RadioGroup.Root>

<style>
	:global(.segmented) {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-text-primary) 6%, transparent);
	}

	:global(.segmented[data-disabled]) {
		opacity: 0.5;
	}

	:global(.segmented-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 10px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		outline: none;
		transition:
			color var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo);
	}

	:global(.segmented-item:hover:not([data-state="checked"]):not([data-disabled])) {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
	}

	:global(.segmented-item[data-state="checked"]) {
		background: var(--color-bg-primary);
		color: var(--color-text-primary);
		box-shadow:
			0 1px 3px rgba(42, 40, 37, 0.08),
			0 2px 8px rgba(42, 40, 37, 0.06),
			0 0 0 0.5px rgba(42, 40, 37, 0.04);
	}

	:global(.dark .segmented-item[data-state="checked"]) {
		background: var(--color-bg-elevated);
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.24),
			0 0 0 0.5px rgba(255, 255, 255, 0.06);
	}

	:global(.segmented-item:focus-visible) {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	:global(.segmented-item[data-disabled]) {
		cursor: not-allowed;
	}
</style>
