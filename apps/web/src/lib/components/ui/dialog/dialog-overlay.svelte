<script lang="ts">
import { Dialog as DialogPrimitive } from "bits-ui";
import { bitsAnim, overlayFadeIn, overlayFadeOut } from "$lib/motion";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: DialogPrimitive.OverlayProps = $props();
</script>

<DialogPrimitive.Overlay {...restProps}>
	{#snippet child({ props })}
		<div
			bind:this={ref}
			{...props}
			data-slot="dialog-overlay"
			class={cn("bg-black/40 supports-backdrop-filter:backdrop-blur-sm fixed inset-0 isolate z-50", className)}
			use:bitsAnim={{ inPreset: overlayFadeIn, outPreset: overlayFadeOut }}
		></div>
	{/snippet}
</DialogPrimitive.Overlay>
