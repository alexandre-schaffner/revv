<script lang="ts">
import { Switch as SwitchPrimitive } from "bits-ui";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

let {
  ref = $bindable(null),
  checked = $bindable(false),
  class: className,
  ...restProps
}: WithoutChildrenOrChild<SwitchPrimitive.RootProps> = $props();
</script>

<SwitchPrimitive.Root
	bind:ref
	data-slot="switch"
	bind:checked
	class={cn(
		"revv-switch peer inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full border border-border-subtle outline-none transition-[background-color,box-shadow,border-color] focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=checked]:border-accent data-[state=unchecked]:bg-bg-elevated data-[state=unchecked]:hover:bg-bg-tertiary",
		className,
	)}
	{...restProps}
>
	<SwitchPrimitive.Thumb
		data-slot="switch-thumb"
		class={cn(
			"revv-switch-thumb pointer-events-none block size-[18px] rounded-full bg-white ring-0 transition-transform duration-200 data-[state=checked]:translate-x-[19px] data-[state=unchecked]:translate-x-0.5",
		)}
	/>
</SwitchPrimitive.Root>

<style>
	:global(.revv-switch) {
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.06);
	}

	:global(.revv-switch[data-state="checked"]) {
		box-shadow:
			inset 0 1px 2px rgba(0, 0, 0, 0.18),
			0 0 0 2px color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	:global(.revv-switch-thumb) {
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.2),
			0 0 0 0.5px rgba(0, 0, 0, 0.05);
		transition:
			transform var(--duration-quick, 200ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
	}
</style>
