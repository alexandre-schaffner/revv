<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type ShimmerProps = HTMLAttributes<HTMLElement> & {
		/** The duration of the shimmer animation in seconds. */
		duration?: number;
		/** The spread multiplier for the shimmer gradient (multiplied by text length). */
		spread?: number;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		duration = 2,
		spread = 2,
		...restProps
	}: ShimmerProps = $props();
</script>

<span
	data-slot="shimmer"
	class={cn(
		"inline-block bg-clip-text text-transparent",
		"bg-[length:200%_100%]",
		"animate-[shimmer_var(--shimmer-duration)_linear_infinite]",
		className,
	)}
	style="--shimmer-duration: {duration}s; background-image: linear-gradient(90deg, currentColor 0%, color-mix(in srgb, currentColor 40%, transparent) 50%, currentColor 100%);"
	{...restProps}
>
	{@render children?.()}
</span>
