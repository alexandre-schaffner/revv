<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type ShimmerProps = HTMLAttributes<HTMLElement> & {
  active?: boolean;
  /** Stagger offset for multiple shimmers running out-of-phase. */
  offset?: number;
};
</script>

<script lang="ts">
	import { tokens } from "$lib/motion";
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		active = true,
		offset = 0,
		...restProps
	}: ShimmerProps = $props();

	// Keep sweeping until the layers' opacity swap (--text-shimmer-swap) ends.
	const swap = tokens.smooth * 1000;

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
	style="--text-shimmer-index: {offset};"
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
