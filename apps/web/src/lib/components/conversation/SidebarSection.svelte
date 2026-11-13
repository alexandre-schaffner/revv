<script lang="ts">
import type { Snippet } from "svelte";

// One section of the conversation sidebar: a small heading, an optional
// control or note beside it, and the section's body. Sections rule each other
// off; in the sidebar's two-column layout a `span` section takes both columns.

interface Props {
  id: string;
  title: string;
  /** Lines the heading up with a text `aside` instead of a control. */
  align?: "center" | "baseline";
  span?: boolean;
  aside?: Snippet;
  children?: Snippet;
}

let { id, title, align = "center", span = false, aside, children }: Props = $props();
</script>

<section class="side-section" class:side-section--span={span} aria-labelledby={id}>
	<header class="side-head" class:side-head--baseline={align === 'baseline'}>
		<h3 {id}>{title}</h3>
		{@render aside?.()}
	</header>
	{@render children?.()}
</section>

<style>
	.side-section {
		padding: 12px 0;
	}

	/* Every section is one of these, so the next one is too. */
	.side-section + :global(.side-section) {
		border-top: 1px solid var(--color-border-subtle);
	}

	.side-section:first-child {
		padding-top: 0;
	}

	.side-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 24px;
		margin-bottom: 6px;
		color: var(--color-text-secondary);
	}

	.side-head--baseline {
		align-items: baseline;
	}

	.side-head h3 {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

	/* Inline above the timeline (narrow main area), the sections pair up
	   into two columns (see ConversationSidebar). */
	@container side (min-width: 520px) {
		.side-section--span {
			grid-column: 1 / -1;
		}

		/* Without a spanning first section, the second starts the right column. */
		.side-section:nth-child(2):not(.side-section--span + .side-section) {
			padding-top: 0;
			border-top: none;
		}
	}
</style>
