<script lang="ts">
	import type { WalkthroughBlock, WalkthroughSemanticStep } from '@revv/shared';
	import { ChevronDown } from '@lucide/svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import WalkthroughMarkdownBlock from './WalkthroughMarkdownBlock.svelte';
	import WalkthroughCodeBlock from './WalkthroughCodeBlock.svelte';
	import WalkthroughDiffBlock from './WalkthroughDiffBlock.svelte';

	type Severity = 'info' | 'warning' | 'critical';

	interface BlockEntry {
		block: WalkthroughBlock;
		delay: number;
		renderedAnnotation: string | null;
	}

	interface Props {
		section: WalkthroughSemanticStep;
		entries: BlockEntry[];
		themeType: 'light' | 'dark' | 'system';
		blockIssueSeverity: Map<string, Severity>;
		selectedIssueBlockId: string | null;
		selectedIssueSeverity: Severity | null;
		/** Index of this section (1-based) shown in the chapter eyebrow. */
		chapterNumber: number;
		/** Total chapter count for the "Chapter N / M" eyebrow. */
		chapterCount: number;
		/**
		 * Optional DOM id placed on the section header so the chapters stepper
		 * can jump to a specific chapter (e.g. id="walkthrough-overview" on the
		 * virtual overview chapter, id="walkthrough-diff" on the first Phase B
		 * chapter). When omitted, only the per-block step anchors are jump targets.
		 */
		id?: string | undefined;
	}

	let {
		section,
		entries,
		themeType,
		blockIssueSeverity,
		selectedIssueBlockId,
		selectedIssueSeverity,
		chapterNumber,
		chapterCount,
		id = undefined,
	}: Props = $props();

	let collapsed = $state(false);

	// Roll up child block severities so a collapsed section can still
	// telegraph the worst issue inside it via a colored dot.
	const SEVERITY_RANK: Record<Severity, number> = {
		info: 1,
		warning: 2,
		critical: 3,
	};
	const rolledSeverity = $derived.by<Severity | null>(() => {
		let worst: Severity | null = null;
		for (const e of entries) {
			const s = blockIssueSeverity.get(e.block.id);
			if (!s) continue;
			if (!worst || SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
		}
		return worst;
	});

	const renderedSummary = $derived(
		section.summary ? renderMarkdown(section.summary) : null,
	);

	function toggle(): void {
		collapsed = !collapsed;
	}

	// Auto-expand when an issue inside this section is selected so the
	// reader's click on the issue card always lands on a visible block.
	$effect(() => {
		if (!selectedIssueBlockId) return;
		const inside = entries.some(
			(e) => e.block.id === selectedIssueBlockId,
		);
		if (inside) collapsed = false;
	});
</script>

<!-- `display: contents` so the section participates transparently in the
     outer `.blocks` 6-col grid: the header lands in col 3 via its own
     class, and child block-groups continue to use their col-3/col-5
     mapping. -->
<div class="walkthrough-section">
	<button
		type="button"
		class="section-header"
		class:section-header--collapsed={collapsed}
		class:section-header--info={rolledSeverity === 'info'}
		class:section-header--warning={rolledSeverity === 'warning'}
		class:section-header--critical={rolledSeverity === 'critical'}
		aria-expanded={!collapsed}
		aria-controls={`section-body-${section.semanticStepIndex}`}
		{id}
		onclick={toggle}
	>
		<div class="section-header-rail">
			<span class="section-eyebrow">
				Chapter {String(chapterNumber).padStart(2, '0')}
				<span class="section-eyebrow-of">/ {String(chapterCount).padStart(2, '0')}</span>
			</span>
			<span class="section-toggle" aria-hidden="true">
				<ChevronDown size={14} />
			</span>
		</div>
		<div class="section-title-row">
			{#if rolledSeverity !== null && collapsed}
				<span
					class="section-severity-dot"
					class:section-severity-dot--info={rolledSeverity === 'info'}
					class:section-severity-dot--warning={rolledSeverity === 'warning'}
					class:section-severity-dot--critical={rolledSeverity === 'critical'}
					aria-label="Section contains a flagged {rolledSeverity} issue"
				></span>
			{/if}
			<h3 class="section-title">{section.title}</h3>
		</div>
		{#if renderedSummary}
			<div class="section-summary">{@html renderedSummary}</div>
		{/if}
	</button>

	{#if !collapsed}
		<div
			class="section-body"
			id={`section-body-${section.semanticStepIndex}`}
			role="region"
			aria-label={section.title}
		>
			{#each entries as { block, delay, renderedAnnotation } (block.id)}
				{@const hasAnnotation = renderedAnnotation !== null}
				{@const blockSeverity = blockIssueSeverity.get(block.id) ?? null}

				<div class="block-group">
					<span
						class="block-step-dot"
						class:block-step-dot--info={blockSeverity === 'info'}
						class:block-step-dot--warning={blockSeverity === 'warning'}
						class:block-step-dot--critical={blockSeverity === 'critical'}
						aria-hidden="true"
					></span>
					<div
						id="step-{block.id}"
						class="block-wrapper"
						class:block-wrapper--no-anim={delay === -1}
						class:block-wrapper--selected-info={selectedIssueBlockId === block.id && selectedIssueSeverity === 'info'}
						class:block-wrapper--selected-warning={selectedIssueBlockId === block.id && selectedIssueSeverity === 'warning'}
						class:block-wrapper--selected-critical={selectedIssueBlockId === block.id && selectedIssueSeverity === 'critical'}
						style:--enter-delay="{delay}ms"
					>
						{#if block.type === 'markdown'}
							<WalkthroughMarkdownBlock content={block.content} />
						{:else if block.type === 'code'}
							<WalkthroughCodeBlock {block} {themeType} hideAnnotation />
						{:else if block.type === 'diff'}
							<WalkthroughDiffBlock {block} {themeType} hideAnnotation />
						{/if}
					</div>

					{#if hasAnnotation}
						<aside
							class="block-annotation"
							class:block-annotation--no-anim={delay === -1}
							style:--enter-delay="{delay}ms"
							aria-label="Annotation"
						>
							<div class="block-annotation-inner">
								{@html renderedAnnotation}
							</div>
						</aside>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* Transparent wrapper so the section's header + body participate
	   directly in the parent `.blocks` 6-col grid declared by
	   GuidedWalkthrough.svelte. */
	.walkthrough-section {
		display: contents;
	}

	/* Header lives in col 3 (the 820 content column), span across the
	   gutter on the right so the chevron lines up with the annotation
	   rail edge. */
	.section-header {
		grid-column: 3;
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
		transition: border-color 200ms ease;
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

	.section-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
		transition: transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1), color 200ms ease;
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
		transition: color 200ms ease;
	}

	.section-header:hover .section-title {
		color: var(--color-accent);
	}

	.section-severity-dot {
		flex-shrink: 0;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--severity-dot-color, var(--color-text-muted));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--severity-dot-color, var(--color-text-muted)) 18%, transparent);
	}

	.section-severity-dot--info {
		--severity-dot-color: var(--color-accent);
	}
	.section-severity-dot--warning {
		--severity-dot-color: var(--color-warning);
	}
	.section-severity-dot--critical {
		--severity-dot-color: var(--color-danger);
	}

	.section-summary {
		font-size: 13px;
		line-height: 1.55;
		color: var(--color-text-secondary);
		max-width: 720px;
	}

	.section-summary :global(p) {
		margin: 0;
	}

	.section-summary :global(code) {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: var(--color-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.section-summary :global(strong) {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/* `display: contents` lets the per-block grid items (block-step-dot
	   in col 2, block-wrapper in col 3, block-annotation in col 5)
	   inherit the parent `.blocks` grid placement they already use. */
	.section-body {
		display: contents;
	}

	/* Per-block grid placement — duplicated from the parent
	   GuidedWalkthrough so the block-group + block-wrapper +
	   block-annotation triplet still lands in cols 2 / 3 / 5 when
	   rendered from this component. */
	.block-group {
		display: contents;
	}

	.block-group > .block-wrapper {
		grid-column: 3;
	}

	.block-group > .block-annotation {
		grid-column: 5;
	}

	.block-step-dot {
		grid-column: 2;
		justify-self: end;
		align-self: flex-start;
		width: 8px;
		height: 8px;
		margin-top: 18px;
		margin-right: 16px;
		border-radius: 50%;
		background: transparent;
	}

	.block-step-dot--info {
		background: var(--color-accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
	}
	.block-step-dot--warning {
		background: var(--color-warning);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning) 18%, transparent);
	}
	.block-step-dot--critical {
		background: var(--color-danger);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 18%, transparent);
	}

	.block-wrapper {
		position: relative;
		max-width: 100%;
		animation: block-slide-up 0.65s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--enter-delay, 0ms);
		will-change: opacity, transform, filter;
		scroll-margin-top: 16px;
		border-radius: 8px;
		outline: 2px solid transparent;
		outline-offset: 2px;
		transition: outline-color 200ms ease;
	}

	.block-wrapper--selected-info {
		outline-color: var(--color-accent);
	}
	.block-wrapper--selected-warning {
		outline-color: var(--color-warning);
	}
	.block-wrapper--selected-critical {
		outline-color: var(--color-danger);
	}

	.block-wrapper--no-anim {
		animation: none;
		opacity: 1;
		transform: none;
		filter: none;
	}

	.block-annotation {
		align-self: start;
		padding: 4px 0;
		animation: block-slide-up 0.65s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--enter-delay, 0ms);
	}

	.block-annotation--no-anim {
		animation: none;
		opacity: 1;
		transform: none;
		filter: none;
	}

	.block-annotation-inner {
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 14px 16px;
		font-size: 14px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.block-annotation-inner :global(p) {
		margin: 0 0 8px;
	}

	.block-annotation-inner :global(p:last-child) {
		margin-bottom: 0;
	}

	.block-annotation-inner :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--color-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.block-annotation-inner :global(strong) {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	@keyframes block-slide-up {
		from {
			opacity: 0;
			transform: translateY(10px);
			filter: blur(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
			filter: blur(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.block-wrapper,
		.block-annotation,
		.section-toggle {
			animation-duration: 0.01ms !important;
			transition: none !important;
		}
	}
</style>
