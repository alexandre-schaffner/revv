<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type ShimmerProps = HTMLAttributes<HTMLElement> & {
  /** Whether the shimmer animation is active. Defaults to true. */
  active?: boolean;
  /** Stagger offset for multiple shimmers running out-of-phase. */
  offset?: number;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		active = true,
		offset = 0,
		...restProps
	}: ShimmerProps = $props();

	const swap = 220;

	// Delayed deactivation: keep the shimmer running for one last sweep cycle
	// before removing the animation, so deactivation feels smooth.
	let run = $state(true);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}

		if (active) {
			run = true;
			return;
		}

		timer = setTimeout(() => {
			timer = undefined;
			run = false;
		}, swap);

		return () => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		};
	});
</script>

<span
	data-component="text-shimmer"
	data-active={active ? "true" : "false"}
	class={cn(className)}
	style="--text-shimmer-swap: {swap}ms; --text-shimmer-index: {offset};"
	{...restProps}
>
	<span data-slot="text-shimmer-char">
		<span data-slot="text-shimmer-char-base" aria-hidden="true">
			{@render children?.()}
		</span>
		<span
			data-slot="text-shimmer-char-shimmer"
			data-run={run ? "true" : "false"}
			aria-hidden="true"
		>
			{@render children?.()}
		</span>
	</span>
</span>
