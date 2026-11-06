<script lang="ts">
/*
 * Not phosphor's ArrowRight: phosphor draws on a square 1:1 grid, and
 * onboarding wants a wide 18×10 arrow with a 1px stroke that reads as a quiet
 * lead-out (CLAUDE.md's inline-SVG carve-out).
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
