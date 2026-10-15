<script lang="ts">
/*
 * ContinueArrow — the long, hairline arrow on onboarding's forward buttons.
 *
 * Deliberately not `phosphor-svelte/lib/ArrowRight`: phosphor draws on a
 * square 1:1 grid, and onboarding wants a wide 18×10 arrow with a 1px stroke
 * so it reads as a quiet lead-out rather than a UI control. This is the
 * "inline SVG only when no phosphor equivalent fits" carve-out from CLAUDE.md
 * — and it lives here once instead of being copy-pasted into every step.
 */
interface Props {
  class?: string;
}

let { class: className = "" }: Props = $props();
</script>

<svg
	width="18"
	height="10"
	viewBox="0 0 18 10"
	fill="none"
	xmlns="http://www.w3.org/2000/svg"
	class={className}
	aria-hidden="true"
>
	<path
		d="M0 5h16M12 1l4 4-4 4"
		stroke="currentColor"
		stroke-width="1"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>
