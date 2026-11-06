<script lang="ts">
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Warning from "phosphor-svelte/lib/Warning";
import { provideActivityPr } from "$lib/components/agent-activity/repo-file";
import ThoughtsReveal from "$lib/components/agent-activity/ThoughtsReveal.svelte";
import ToolActivityGroup from "$lib/components/agent-activity/ToolActivityGroup.svelte";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import WalkthroughRatingsGrid from "$lib/components/review/spec-panel/RatingsGrid.svelte";
import ChangedAboveNote from "$lib/components/stack/margin/ChangedAboveNote.svelte";
import ReliedOnNote from "$lib/components/stack/margin/ReliedOnNote.svelte";
import { spreadRailNotes } from "$lib/components/stack/margin/spread-notes";
import { stackCitations } from "$lib/components/stack/margin/stack-citations.svelte";
import StackHandoffCard from "$lib/components/stack/StackHandoffCard.svelte";
import IssueStackNote from "$lib/components/stack/walkthrough/IssueStackNote.svelte";
import StackOverviewRow from "$lib/components/stack/walkthrough/StackOverviewRow.svelte";
import { WalkthroughStack } from "$lib/components/stack/walkthrough/walkthrough-stack.svelte";
import { Button } from "$lib/components/ui/button";
import { Progress } from "$lib/components/ui/progress";
import { Shimmer } from "$lib/components/ui/shimmer";
import { enterOnce } from "$lib/motion";
import { jumpToDiffLine, scrollToAnchor } from "$lib/stores/review-nav.svelte";
import { resume, retryWalkthroughClone } from "$lib/stores/walkthrough-actions";
import { sortBySeverity } from "$lib/utils/walkthrough-issues";
import ChapterStepper, { type StepperChapter } from "./ChapterStepper.svelte";
import FirstPassLeads from "./first-pass/FirstPassLeads.svelte";
import FirstPassPreview from "./first-pass/FirstPassPreview.svelte";
import FirstPassRibbon from "./first-pass/FirstPassRibbon.svelte";
import IssueCard from "./IssueCard.svelte";
import IssueGroups from "./IssueGroups.svelte";
import LowSignalDisclosure from "./LowSignalDisclosure.svelte";
import MergedStamp from "./MergedStamp.svelte";
import WalkthroughSection from "./WalkthroughSection.svelte";
import { FIRST_PASS_SPINNER, WalkthroughView } from "./walkthrough-view.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();
provideActivityPr(() => prId);

const view = new WalkthroughView(() => prId);
/** Entrance keys of this walkthrough's parts; a new run enters afresh. */
const enterScope = $derived(`wt:${view.walkthroughId ?? prId}`);

let firstPassOpen = $state(false);
let thoughtsOpen = $state(true);

const stepperChapters = $derived(
  view.stepperChapters.map(
    (chapter): StepperChapter =>
      chapter.id === "first-pass"
        ? { ...chapter, extra: firstPassRibbon, onjump: () => (firstPassOpen = true) }
        : chapter,
  ),
);

const stack = new WalkthroughStack(
  () => prId,
  () => ({
    chapters: view.chapters.map(({ section, entries }) => ({
      index: section.semanticStepIndex,
      files: entries.flatMap(({ block }) =>
        block.type === "code" || block.type === "diff" ? [block.filePath] : [],
      ),
    })),
    issues: sortBySeverity(view.issues),
  }),
);

// The issue the reader clicked keeps a severity outline on its block until
// another is picked, or a click lands elsewhere.
let selectedIssueId = $state<string | null>(null);
const selectedIssue = $derived(
  selectedIssueId ? (view.issues.find((i) => i.id === selectedIssueId) ?? null) : null,
);
const selectedIssueBlockId = $derived(selectedIssue?.blockIds[0] ?? null);
const selectedIssueSeverity = $derived(selectedIssue?.severity ?? null);

$effect(() => {
  void prId;
  selectedIssueId = null;
});

$effect(() => {
  if (selectedIssueId === null) return;
  const blockId = selectedIssueBlockId;
  function onDocumentClick(e: MouseEvent): void {
    const target = e.target as Element | null;
    if (!target) return;
    if (blockId && document.getElementById(`step-${blockId}`)?.contains(target)) return;
    // The card's own click re-selects; clearing here would race it.
    if (target.closest(".issue-card")) return;
    selectedIssueId = null;
  }
  document.addEventListener("click", onDocumentClick);
  return () => document.removeEventListener("click", onDocumentClick);
});

function selectIssue(issueId: string, blockId: string): void {
  selectedIssueId = issueId;
  scrollToAnchor("walkthrough", `step-${blockId}`);
}

function jumpToBlock(blockId: string): void {
  scrollToAnchor("walkthrough", `step-${blockId}`, { highlight: true });
}

function jumpToSection(elementId: string): void {
  scrollToAnchor("walkthrough", elementId);
}

let retryingClone = $state(false);
async function handleRetryClone(repoId: string): Promise<void> {
  if (retryingClone) return;
  retryingClone = true;
  try {
    await retryWalkthroughClone(prId, repoId);
  } finally {
    retryingClone = false;
  }
}

function handleResume(): void {
  void resume(prId);
}
</script>

{#snippet firstPassRibbon()}
	<FirstPassRibbon rows={view.firstPass.rows} />
{/snippet}

{#snippet reliedOnMargin()}
	{#if stack.notes && stack.place}
		<ReliedOnNote links={stack.notes.reliedOn} place={stack.place} />
	{/if}
{/snippet}

{#snippet changedAboveMargin(index: number)}
	{@const note = stack.notes?.chapters.get(index)}
	{#if note && stack.place}
		<ChangedAboveNote {note} place={stack.place} />
	{/if}
{/snippet}

{#snippet ratingsGrid(forceShow: boolean)}
	<div id="walkthrough-rating" class="sentiment-scorecard">
		<WalkthroughRatingsGrid ratings={view.ratings} blocks={view.blocks} onJump={jumpToBlock} {forceShow} />
	</div>
{/snippet}

{#snippet firstPassLeads()}
	<FirstPassLeads
		leads={view.firstPass.unraised}
		note={view.firstPass.note}
		isComplete={!view.isStreaming}
		bind:open={firstPassOpen}
		onjump={jumpToDiffLine}
	/>
{/snippet}

<div class="walkthrough" use:stackCitations={stack.place}>
	{#if view.merged}
		<!-- Its own row on the review grid, so the stamp sits on the content
		     column's right edge and never overlaps the stepper below. -->
		<div class="merged-stamp-row review-columns">
			<MergedStamp {prId} mergedAt={view.merged.at} />
		</div>
	{/if}

	{#if stack.isStacked}
		<StackOverviewRow {prId} />
	{/if}

	{#if view.stepperVisible}
		<!-- Outside the page states, so it stays mounted from the loading
		     skeleton through the content and after generation. -->
		<div
			class="walkthrough-stepper-header review-columns"
			use:enterOnce={{ key: `wt:${prId}:stepper`, look: "surface" }}
		>
			<ChapterStepper
				chapters={stepperChapters}
				activeId={view.stepperActiveId}
				isStreaming={view.isStreaming}
				toolCalls={view.toolCalls}
				onjump={jumpToSection}
			/>
		</div>
	{/if}

	{#if view.page.kind === 'error-empty'}
		<div class="walkthrough-empty" class:walkthrough-empty--in-flow={stack.isStacked}>
			{#if view.page.explorations.length > 0}
				<div class="exploration-feed">
					{#each view.page.explorations as step, i (i)}
						<div class="exploration-item" use:enterOnce={{ look: 'surface' }}>
							<span class="exploration-tool">{step.toolName}</span>
							<span class="exploration-desc">{step.summary}</span>
						</div>
					{/each}
				</div>
			{/if}
			<p class="loading-text">Walkthrough generation stopped. Check the notification for details.</p>
			<Button variant="outline" size="lg" style="cursor: pointer;" onclick={handleResume}>
				<ArrowsClockwise size={16} />
				Retry
			</Button>
		</div>
	{:else if view.page.kind === 'cloning'}
		{@const repoId = view.page.repoId}
		<div class="walkthrough-empty" class:walkthrough-empty--in-flow={stack.isStacked}>
			{#if !repoId}
				<Warning size={20} weight="fill" />
				<p class="loading-text">Couldn't identify the repository that was cloning.</p>
			{:else}
				<div class="clone-progress-container">
					<p class="loading-text">Cloning repository…</p>
					<Progress indeterminate class="clone-progress-bar" />
					<p class="loading-subtext">The walkthrough will start automatically when cloning completes.</p>
					<Button
						variant="outline"
						size="lg"
						style="cursor: pointer;"
						disabled={retryingClone}
						onclick={() => handleRetryClone(repoId)}
					>
						<ArrowsClockwise size={16} />
						Retry clone
					</Button>
				</div>
			{/if}
		</div>
	{:else if view.page.kind === 'first-pass-only'}
		<div class="walkthrough-loading review-columns">
			<FirstPassPreview view={view.firstPass} spinner={FIRST_PASS_SPINNER} onjump={jumpToDiffLine} />
		</div>
	{:else if view.page.kind === 'empty'}
		<div class="walkthrough-empty" class:walkthrough-empty--in-flow={stack.isStacked}>
			<p class="loading-text">No walkthrough generated yet for this PR.</p>
		</div>
	{:else if view.page.kind === 'loading'}
		<!-- Before the first write lands. The 9-axis grid is up from the start
		     so the reviewer watches its cells resolve. -->
		<div class="walkthrough-loading review-columns">
			{@render ratingsGrid(true)}
		</div>
	{:else if view.page.kind === 'content'}
		<div
			class="walkthrough-content review-columns"
			data-prlens-breakout=""
			use:enterOnce={{ key: `${enterScope}:content`, look: 'surface', delay: 0.06 }}
		>
			{#if view.streamError}
				<div class="partial-error" role="status">
					<div class="partial-error-copy">
						<Warning size={14} weight="fill" />
						<span>{view.streamError}</span>
					</div>
					<Button variant="outline" size="sm" style="cursor: pointer;" onclick={handleResume}>
						<ArrowsClockwise size={14} />
						Retry
					</Button>
				</div>
			{/if}

			{#if view.issues.length > 0 || view.filteredIssues.length > 0}
				<div
					class="issues-section"
					use:enterOnce={{ key: `${enterScope}:issues`, look: 'settle', delay: 0.15 }}
					{@attach stack.notes && stack.notes.issues.size > 1 ? spreadRailNotes : undefined}
				>
					<div class="issues-header">
						<Warning size={13} weight="fill" />
						<span>{view.issues.length} issue{view.issues.length !== 1 ? 's' : ''} flagged</span>
					</div>
					<IssueGroups issues={view.issues}>
						{#snippet item(issue)}
							{@const { targetBlockId, stepTag } = view.issueTarget(issue)}
							<IssueStackNote {stack} issueId={issue.id}>
								<IssueCard
									{issue}
									clickable={targetBlockId !== null}
									onclick={() => {
										if (targetBlockId) selectIssue(issue.id, targetBlockId);
									}}
									{stepTag}
									entrance={{
										key: `${enterScope}:issue:${issue.id}`,
										look: 'card',
										cascade: { group: 'walkthrough-issues', step: 0.05, cap: 6 },
									}}
									firstPassSmells={view.firstPass.smellsByIssue.get(issue.id)}
								/>
							</IssueStackNote>
						{/snippet}
					</IssueGroups>

					<LowSignalDisclosure count={view.filteredIssues.length}>
						{#each view.filteredIssues as issue (issue.id)}
							<IssueCard
								{issue}
								stepTag={null}
								firstPassSmells={view.firstPass.smellsByIssue.get(issue.id)}
							/>
						{/each}
					</LowSignalDisclosure>

					{#if view.firstPass.hasLeads}
						<div id="walkthrough-first-pass">{@render firstPassLeads()}</div>
					{/if}
				</div>
			{:else if view.firstPass.hasLeads}
				<div id="walkthrough-first-pass" class="first-pass-section">{@render firstPassLeads()}</div>
			{/if}

			<!-- The Overview, then each Phase B chapter; the sentiment and the
			     scorecard close the grid. -->
			<div class="blocks review-columns" data-col="full">
				{#if view.overview}
					<WalkthroughSection
						id={view.overview.anchorId}
						section={view.overview.section}
						entries={view.overview.entries}
						blockSeverity={view.blockSeverity}
						{selectedIssueBlockId}
						{selectedIssueSeverity}
						chapterNumber={null}
						chapterCount={view.chapterCount}
						margin={stack.notes && stack.notes.reliedOn.length > 0 ? reliedOnMargin : undefined}
						{enterScope}
						cascade={false}
					/>
				{/if}
				{#each view.chapters as chapter (chapter.section.semanticStepIndex)}
					<WalkthroughSection
						id={chapter.anchorId}
						section={chapter.section}
						entries={chapter.entries}
						blockSeverity={view.blockSeverity}
						{selectedIssueBlockId}
						{selectedIssueSeverity}
						chapterNumber={chapter.number}
						chapterCount={view.chapterCount}
						margin={stack.notes?.chapters.has(chapter.section.semanticStepIndex) ? changedAboveMargin : undefined}
						{enterScope}
					/>
				{/each}

				{#if view.showDiffSkeleton}
					<!-- The recap pattern: the "Reviewing…" shimmer toggles the
					     model's streamed thoughts, interleaved with its tool calls. -->
					<div class="block-group">
						<span class="block-step-dot" data-col="gutter" aria-hidden="true"></span>
						<div class="walkthrough-skeleton" data-col="content">
							<ThoughtsReveal
								bind:open={thoughtsOpen}
								triggerClass="walkthrough-phase-trigger"
								ariaLabel="Reviewing. Toggle streamed thoughts."
								metaLabel=""
							>
								{#snippet prefix()}
									<Shimmer class="text-sm" aria-label="Reviewing">Reviewing...</Shimmer>
								{/snippet}
								{#if view.activity.length > 0}
									<div class="walkthrough-activity-stack">
										{#each view.activity as entry, entryIdx (entry.id)}
											{#if entry.kind === 'thought'}
												<div class="walkthrough-activity-entry" data-kind="thought">
													<Markdown class="walkthrough-inline-thought" source={entry.text} trust="agent" />
												</div>
											{:else}
												<div class="walkthrough-activity-entry" data-kind="explorations">
													<ToolActivityGroup
														items={entry.items}
														active={entryIdx === view.activity.length - 1}
														defaultOpen={false}
													/>
												</div>
											{/if}
										{/each}
									</div>
								{:else}
									<p class="walkthrough-thought-empty">
										No streamed thoughts yet. Tool calls will appear here as they happen.
									</p>
								{/if}
							</ThoughtsReveal>
						</div>
					</div>
				{/if}

				<!-- While generating, the scorecard stays up with queued cells as
				     the destination for Phase D. -->
				{#if view.sentiment !== null || view.ratings.length > 0 || view.isStreaming}
					<div class="sentiment-stack" data-col="content">
						{#if view.sentiment !== null}
							<div id="walkthrough-sentiment" class="sentiment-card" aria-label="Overall sentiment">
								<div class="sentiment-card-header">
									<h3 class="sentiment-card-title">Overall Sentiment</h3>
								</div>
								<Markdown class="sentiment-card-body" source={view.sentiment} trust="agent" />
							</div>
						{/if}
						{#if view.ratings.length > 0 || view.isStreaming}
							{@render ratingsGrid(view.isStreaming)}
						{/if}
					</div>
				{/if}
			</div>

			{#if view.footerParts.length > 0}
				<footer class="walkthrough-footer">
					<span>{view.footerParts.join(" · ")}</span>
				</footer>
			{/if}

			{#if stack.isStacked && view.isComplete}
				<div class="stack-handoff-slot">
					<StackHandoffCard {prId} />
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.walkthrough {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	.walkthrough-content {
		padding: 28px 0;
	}

	/* Same attribution line as the recap detail footer. */
	.walkthrough-footer {
		margin-top: 1.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 0.75rem;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		letter-spacing: 0.01em;
	}

	/* Centred in the main pane: positioned against the route's
	   `.review-page`, so the button lands at the pane's middle whatever sits
	   above it. Clicks pass through the empty area. */
	.walkthrough-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 24px;
		pointer-events: none;
	}

	/* `:global(*)`: the shadcn Button carries another component's scope. */
	.walkthrough-empty > :global(*) {
		pointer-events: auto;
	}

	.walkthrough-empty--in-flow {
		position: static;
		inset: auto;
		min-height: 40vh;
	}

	.stack-handoff-slot {
		min-width: 0;
	}

	.walkthrough-loading {
		padding: 28px 0;
		row-gap: 20px;
	}

	.merged-stamp-row {
		padding: 20px 0 0;
	}

	/* `:global(*)`: the stamp is another component's root. */
	.merged-stamp-row > :global(*) {
		justify-self: end;
		/* Lifts the stamp into the header's empty right margin without moving
		   the stepper: the two margins cancel. */
		margin-top: -22px;
		margin-bottom: 22px;
	}

	.walkthrough-stepper-header {
		padding: 24px 0 4px;
	}

	.walkthrough-stepper-header + .walkthrough-loading,
	.walkthrough-stepper-header + .walkthrough-content {
		padding-top: 14px;
	}

	/* The error state's trace of what the agent attempted before it stopped. */
	.exploration-feed {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 3px;
		overflow: hidden;
		padding: 10px 12px;
		background: var(--color-bg-secondary);
		border-radius: 6px;
		border: 1px solid var(--color-border);
		opacity: 0.5;
		margin-bottom: 8px;
		max-width: 520px;
	}

	.exploration-item {
		display: flex;
		gap: 8px;
		font-size: 11px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.exploration-tool {
		color: var(--color-accent);
		flex-shrink: 0;
		min-width: 36px;
		font-weight: 500;
	}

	.exploration-desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.issues-section {
		margin-top: 20px;
		margin-bottom: 4px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* No issues to sit under: the leads take the issues' slot. */
	.first-pass-section {
		margin-top: 20px;
	}

	.issues-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.blocks {
		row-gap: 20px;
		margin-top: 20px;
	}

	.block-group {
		display: contents;
	}

	/* Holds the skeleton row's height, like a block's severity dot. */
	.block-step-dot {
		justify-self: end;
		align-self: flex-start;
		width: 8px;
		height: 8px;
		margin-top: 18px;
		margin-right: 16px;
	}

	/* The sentiment card above the scorecard, as one content-column item. */
	.sentiment-stack {
		display: flex;
		flex-direction: column;
		gap: 16px;
		align-items: stretch;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.sentiment-stack > :global(*) {
		width: 100%;
		min-width: 0;
	}

	.walkthrough-skeleton {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.walkthrough-activity-stack {
		display: flex;
		flex-direction: column;
		margin-top: 0.375rem;
		padding-left: 0.75rem;
		border-left: 1px solid var(--color-border);
	}

	.walkthrough-activity-entry + .walkthrough-activity-entry {
		margin-top: 0.375rem;
	}

	.walkthrough-activity-entry[data-kind="thought"] + .walkthrough-activity-entry[data-kind="explorations"] {
		margin-top: 0.25rem;
	}

	.walkthrough-activity-entry[data-kind="explorations"] + .walkthrough-activity-entry[data-kind="thought"] {
		margin-top: 0.875rem;
	}

	.walkthrough-thought-empty {
		margin: 0.375rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.walkthrough-activity-entry :global(.walkthrough-inline-thought) {
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--color-text-muted);
		word-break: break-word;
	}

	.loading-text {
		font-size: 13px;
		color: var(--color-text-muted);
	}

	.loading-subtext {
		font-size: 11px;
		color: var(--color-text-muted);
		opacity: 0.6;
		margin: 0;
	}

	.partial-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* The button wraps under the copy rather than the copy breaking one
		   character per line. */
		flex-wrap: wrap;
		gap: 12px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
		color: var(--color-danger);
		padding: 10px 12px;
		font-size: 12px;
		line-height: 1.45;
	}

	.partial-error-copy {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
	}

	.partial-error-copy span {
		overflow-wrap: anywhere;
	}

	.clone-progress-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		width: 100%;
		max-width: 320px;
	}

	:global(.clone-progress-bar) {
		width: 100%;
	}

	.sentiment-card {
		background: color-mix(in srgb, var(--color-accent) 5%, var(--color-bg-secondary));
		border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
		border-radius: 10px;
		padding: 16px 20px;
	}

	.sentiment-card-header {
		margin-bottom: 10px;
	}

	.sentiment-card-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.sentiment-card :global(.sentiment-card-body) {
		font-size: 14px;
		line-height: 1.65;
		color: var(--color-text-secondary);
	}

	/* Below the rail breakpoint the blocks stack with no gap between them,
	   and the issues sit 20px above the blocks. */
	@container review (max-width: 1335px) {
		.blocks {
			row-gap: 0;
		}

		.issues-section {
			margin-bottom: 0;
		}
	}
</style>
