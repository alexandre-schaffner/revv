<script lang="ts">
import type { IssueSeverity, WalkthroughSemanticStep } from "@revv/shared";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import type { Snippet } from "svelte";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import { type EnterCascade, enterOnce } from "$lib/motion";
import { walkthroughAnchor } from "$lib/stores/review-nav.svelte";
import { worstSeverity } from "$lib/walkthrough/issues";
import WalkthroughArtifactBlock from "./WalkthroughArtifactBlock.svelte";
import WalkthroughCodeBlock from "./WalkthroughCodeBlock.svelte";
import WalkthroughDiffBlock from "./WalkthroughDiffBlock.svelte";
import type { ChapterEntry } from "./walkthrough-view.svelte";

interface Props {
  prId: string;
  section: WalkthroughSemanticStep;
  entries: ChapterEntry[];
  blockSeverity: ReadonlyMap<string, IssueSeverity>;
  selectedIssueBlockId: string | null;
  selectedIssueSeverity: IssueSeverity | null;
  /**
   * The "Chapter N / M" eyebrow, or null for the Overview, which carries none
   * so the printed numbers match what the chat agent reads as `chapterNumber`.
   */
  chapterNumber: number | null;
  chapterCount: number;
  /** The stepper's jump target, on the section header. */
  id?: string | undefined;
  margin?: Snippet<[number]> | undefined;
  /** Prefix of each block's entrance key: the walkthrough it belongs to. */
  enterScope: string;
  /** Blocks arriving together cascade; the Overview enters on its own. */
  cascade?: boolean;
}

let {
  prId,
  section,
  entries,
  blockSeverity,
  selectedIssueBlockId,
  selectedIssueSeverity,
  chapterNumber,
  chapterCount,
  id = undefined,
  margin = undefined,
  enterScope,
  cascade = true,
}: Props = $props();

let collapsed = $state(false);

// A collapsed section still shows the worst issue inside it.
const rolledSeverity = $derived(worstSeverity(entries.map((e) => blockSeverity.get(e.block.id))));

// The margin note takes the first block's row too when that block has no
// annotation of its own in the rail.
const marginRows = $derived(!collapsed && entries[0]?.annotation === null ? 2 : 1);

function blockCascade(blockId: string): EnterCascade | undefined {
  return cascade ? { group: "walkthrough-blocks", step: 0.085, cap: 10, beat: blockId } : undefined;
}

// Selecting an issue inside a collapsed section opens it, so the jump lands.
$effect(() => {
  if (!selectedIssueBlockId) return;
  if (entries.some((e) => e.block.id === selectedIssueBlockId)) collapsed = false;
});
</script>

<!-- `display: contents`: the header, margin note and blocks are items of
     the parent `.blocks` review grid. -->
<div class="walkthrough-section">
	<button
		type="button"
		class="section-header"
		data-col="content"
		class:section-header--collapsed={collapsed}
		aria-expanded={!collapsed}
		aria-controls={`section-body-${section.semanticStepIndex}`}
		{id}
		onclick={() => (collapsed = !collapsed)}
	>
		<div class="section-header-rail">
			{#if chapterNumber !== null}
				<span class="section-eyebrow">
					Chapter {String(chapterNumber).padStart(2, '0')}
					<span class="section-eyebrow-of">/ {String(chapterCount).padStart(2, '0')}</span>
				</span>
			{/if}
			<span class="section-toggle" aria-hidden="true">
				<CaretDown size={14} />
			</span>
		</div>
		<div class="section-title-row">
			{#if rolledSeverity !== null && collapsed}
				<span
					class="section-severity-dot"
					data-severity={rolledSeverity}
					aria-label="Section contains a flagged {rolledSeverity} issue"
				></span>
			{/if}
			<h3 class="section-title">{section.title}</h3>
		</div>
		{#if section.summary}
			<Markdown class="section-summary" source={section.summary} trust="agent" density="dense" />
		{/if}
	</button>

	{#if margin}
		<div class="section-margin" data-col="rail" style:--rail-rows={marginRows}>
			{@render margin(section.semanticStepIndex)}
		</div>
	{/if}

	{#if !collapsed}
		<div
			class="section-body"
			id={`section-body-${section.semanticStepIndex}`}
			role="region"
			aria-label={section.title}
		>
			{#each entries as { block, annotation } (block.id)}
				{@const severity = blockSeverity.get(block.id) ?? null}
				{@const selected = selectedIssueBlockId === block.id ? selectedIssueSeverity : null}
				<div class="block-group">
					<span
						class="block-step-dot"
						data-severity={severity}
						data-col="gutter"
						aria-hidden="true"
					></span>
					<div
						id={walkthroughAnchor.block(block.id)}
						class="block-wrapper"
						data-severity={selected}
						data-col="content"
						data-prlens-breakout={annotation !== null ? "" : undefined}
						use:enterOnce={{ key: `${enterScope}:block:${block.id}`, look: "rise", cascade: blockCascade(block.id) }}
					>
						{#if block.type === 'markdown'}
							<Markdown source={block.content} trust="agent" />
						{:else if block.type === 'code'}
							<WalkthroughCodeBlock {prId} {block} />
						{:else if block.type === 'diff'}
							<WalkthroughDiffBlock {prId} {block} />
						{:else if block.type === 'artifact'}
							<WalkthroughArtifactBlock {block} />
						{/if}
					</div>

					{#if annotation !== null}
						<aside
							class="block-annotation"
							data-col="rail"
							data-prlens-breakout=""
							aria-label="Annotation"
							use:enterOnce={{ key: `${enterScope}:note:${block.id}`, look: "rise", cascade: blockCascade(block.id) }}
						>
							<Markdown class="block-annotation-inner" source={annotation} trust="agent" />
						</aside>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.walkthrough-section {
		display: contents;
	}

	.section-header {
		appearance: none;
		background: transparent;
		border: none;
		text-align: left;
		font: inherit;
		color: inherit;
		cursor: pointer;
		padding: 14px 0 12px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
		min-width: 0;
		border-top: 1px solid var(--color-border);
		transition: border-color var(--duration-snap) var(--ease-soft);
	}

	.section-header:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.section-header-rail {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.section-eyebrow {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 11.5px;
		font-weight: 500;
		letter-spacing: 0.3px;
		color: var(--color-accent);
		white-space: nowrap;
	}

	.section-eyebrow-of {
		color: var(--color-text-muted);
		font-weight: 400;
		margin-left: 4px;
	}

	/* `margin-left: auto` keeps the chevron right-aligned on the Overview,
	   which has no eyebrow to its left. */
	.section-toggle {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
		transition: transform var(--duration-smooth) var(--ease-standard), color var(--duration-snap) var(--ease-soft);
	}

	.section-header--collapsed .section-toggle {
		transform: rotate(-90deg);
	}

	.section-header:hover .section-toggle {
		color: var(--color-text-primary);
	}

	.section-title-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.section-title {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 22px;
		font-weight: 500;
		letter-spacing: -0.012em;
		line-height: 1.15;
		color: var(--color-text-primary);
		margin: 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: color var(--duration-snap) var(--ease-soft);
	}

	.section-header:hover .section-title {
		color: var(--color-accent);
	}

	.section-severity-dot {
		flex-shrink: 0;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--severity-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--severity-color) 18%, transparent);
	}

	.section-margin {
		align-self: start;
		position: relative;
		z-index: 2;
		min-width: 0;
	}

	.walkthrough-section :global(.section-summary) {
		max-width: 720px;
	}

	.section-body,
	.block-group {
		display: contents;
	}

	.block-step-dot {
		justify-self: end;
		align-self: flex-start;
		width: 8px;
		height: 8px;
		margin-top: 18px;
		margin-right: 16px;
		border-radius: 50%;
		background: transparent;
	}

	.block-step-dot[data-severity] {
		background: var(--severity-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--severity-color) 18%, transparent);
	}

	/* `--jump-highlight` (0–1) is driven by `pulseHighlight` after a jump. */
	.block-wrapper {
		position: relative;
		max-width: 100%;
		scroll-margin-top: 16px;
		border-radius: 8px;
		outline: 2px solid
			color-mix(in srgb, var(--color-accent) calc(var(--jump-highlight, 0) * 100%), transparent);
		outline-offset: 2px;
		transition: outline-color var(--duration-snap) var(--ease-soft);
	}

	/* The selected issue's block, outlined in its severity. */
	.block-wrapper[data-severity] {
		outline-color: var(--severity-color);
	}

	.block-annotation {
		align-self: start;
		padding: 4px 0;
	}

	.block-annotation :global(.block-annotation-inner) {
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 14px 16px;
		font-size: 14px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	/* Rail items stack under their block (see review-columns.css). */
	@container review (max-width: 1335px) {
		.block-annotation {
			padding: 0;
			margin-top: 10px;
		}

		.section-margin {
			margin: 0 0 18px;
		}
	}
</style>
