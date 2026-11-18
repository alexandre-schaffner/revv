<script lang="ts">
/*
 * The last look before a review goes to GitHub: the event, then one list of
 * what it posts (the walkthrough issues its body lists, new line comments,
 * replies). Any item can be left out, keeping it a local draft, and put back.
 * The shell is `ConfirmDialog`'s; the list is a review-page spec panel.
 */
import { ISSUE_SEVERITY_LABEL, type ReviewAction, type WalkthroughIssue } from "@revv/shared";
import { Dialog } from "bits-ui";
import ArrowBendUpLeft from "phosphor-svelte/lib/ArrowBendUpLeft";
import ArrowCounterClockwise from "phosphor-svelte/lib/ArrowCounterClockwise";
import Chat from "phosphor-svelte/lib/Chat";
import ChatCircle from "phosphor-svelte/lib/ChatCircle";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import GitDiff from "phosphor-svelte/lib/GitDiff";
import Robot from "phosphor-svelte/lib/Robot";
import Spinner from "phosphor-svelte/lib/Spinner";
import Warning from "phosphor-svelte/lib/Warning";
import X from "phosphor-svelte/lib/X";
import { untrack } from "svelte";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import SegmentedControl, {
  type SegmentedOption,
} from "$lib/components/ui/segmented-control/SegmentedControl.svelte";
import {
  bitsAnim,
  dialogSpringIn,
  dialogSpringOut,
  gsapFadeY,
  gsapPress,
  overlayFadeIn,
  overlayFadeOut,
  tokens,
} from "$lib/motion";
import { lineRangeLabel, type PostableThread, postableThreads } from "$lib/review/threads";
import { outstandingItemsPhrase } from "$lib/walkthrough/issues";
import SpecPanel from "./spec-panel/SpecPanel.svelte";

interface Props {
  open: boolean;
  prId: string;
  /** The event the reviewer clicked; the dialog can switch it. */
  initialAction: ReviewAction;
  /** On your own PR GitHub only takes a comment review. */
  commentOnly: boolean;
  /** The walkthrough issues ticked on the page. */
  issues: readonly WalkthroughIssue[];
  /** Still open on the PR: what an approval would leave unaddressed. */
  unresolvedIssueCount: number;
  unresolvedThreadCount: number;
  submitting: boolean;
  /** Resolves true once GitHub has the review; the dialog then closes. */
  onsubmit: (
    action: ReviewAction,
    issues: readonly WalkthroughIssue[],
    threadIds: readonly string[],
  ) => Promise<boolean>;
}

let {
  open = $bindable(),
  prId,
  initialAction,
  commentOnly,
  issues,
  unresolvedIssueCount,
  unresolvedThreadCount,
  submitting,
  onsubmit,
}: Props = $props();

let action = $state<ReviewAction>("comment");
let leftOutIssues = $state<ReadonlySet<string>>(new Set());
let leftOutThreads = $state<ReadonlySet<string>>(new Set());
let expanded = $state<ReadonlySet<string>>(new Set());

// Every opening starts from what the page has picked.
$effect(() => {
  if (!open) return;
  untrack(() => {
    action = commentOnly ? "comment" : initialAction;
    leftOutIssues = new Set();
    leftOutThreads = new Set();
    expanded = new Set();
  });
});

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

const keptIssues = $derived(issues.filter((issue) => !leftOutIssues.has(issue.id)));
const keptIssueIds = $derived(new Set(keptIssues.map((issue) => issue.id)));

// Rows are listed as if every ticked issue stays, so leaving an issue out
// greys its comment rather than making the row vanish.
const rows = $derived(postableThreads(prId, new Set(issues.map((issue) => issue.id))));
const posting = $derived(
  new Map(postableThreads(prId, keptIssueIds).map((row) => [row.thread.id, row])),
);

type RowState = "kept" | "left-out" | "with-issue";
function rowState(row: PostableThread): RowState {
  if (leftOutThreads.has(row.thread.id)) return "left-out";
  return posting.has(row.thread.id) ? "kept" : "with-issue";
}

// New threads before replies, each in file order.
const threadRows = $derived([
  ...rows.filter((row) => row.kind === "comment"),
  ...rows.filter((row) => row.kind === "reply"),
]);
const keptRows = $derived(
  rows.filter((row) => rowState(row) === "kept").map((row) => posting.get(row.thread.id) ?? row),
);
const keptComments = $derived(keptRows.filter((row) => row.kind === "comment").length);
const keptReplies = $derived(
  keptRows.filter((row) => row.kind === "reply").reduce((n, row) => n + row.bodies.length, 0),
);

const blocker = $derived.by((): string | null => {
  if (action === "approve") return null;
  if (keptIssues.length > 0 || keptComments > 0) return null;
  if (action === "request_changes") return "Requesting changes needs an issue or a comment.";
  return keptReplies > 0 ? null : "Nothing left to post.";
});

const unresolvedPhrase = $derived(
  outstandingItemsPhrase(unresolvedIssueCount, unresolvedThreadCount),
);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const description = $derived.by(() => {
  const parts: string[] = [];
  if (keptIssues.length > 0) parts.push(plural(keptIssues.length, "issue"));
  if (keptComments > 0) parts.push(plural(keptComments, "comment"));
  if (keptReplies > 0) parts.push(plural(keptReplies, "reply", "replies"));
  if (parts.length === 0) return action === "approve" ? "Approval only." : "Nothing to post.";
  const last = parts.pop();
  return `Posts ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}.`;
});

const leftOutCount = $derived(
  issues.filter((issue) => leftOutIssues.has(issue.id)).length +
    rows.filter((row) => leftOutThreads.has(row.thread.id)).length,
);

const ACTIONS: Record<
  ReviewAction,
  { label: string; confirm: string; tone: "accent" | "danger" | "success" }
> = {
  comment: { label: "Comment", confirm: "Post review", tone: "accent" },
  request_changes: { label: "Request changes", confirm: "Request changes", tone: "danger" },
  approve: { label: "Approve", confirm: "Approve", tone: "success" },
};

const actionOptions: SegmentedOption<ReviewAction>[] = [
  { value: "comment", label: ACTIONS.comment.label, icon: ChatCircle },
  { value: "request_changes", label: ACTIONS.request_changes.label, icon: GitDiff },
  { value: "approve", label: ACTIONS.approve.label, icon: CheckCircle },
];

/** Compiler-style prefix, as the issues panel shows it. */
const SEVERITY_CODE: Record<WalkthroughIssue["severity"], string> = {
  critical: "E",
  warning: "W",
  info: "I",
};

/** A body runs to three lines; longer ones open on "show all". */
function isLong(text: string): boolean {
  return text.length > 200 || text.split("\n").length > 3;
}

const canConfirm = $derived(!submitting && blocker === null);

async function confirm(): Promise<void> {
  if (!canConfirm) return;
  const threadIds = keptRows.map((row) => row.thread.id);
  if (await onsubmit(action, keptIssues, threadIds)) open = false;
}

/** ⌘↵ submits from anywhere in the dialog, as it does in the comment editors. */
function onDialogKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  void confirm();
}
</script>

{#snippet actionGlyph(which: ReviewAction, size: number)}
	{#if which === 'approve'}
		<CheckCircle {size} weight="fill" />
	{:else if which === 'request_changes'}
		<GitDiff {size} weight="bold" />
	{:else}
		<ChatCircle {size} />
	{/if}
{/snippet}

{#snippet rowToggle(leftOut: boolean, what: string, onclick: () => void)}
	<button
		type="button"
		class="row-ctrl"
		class:row-ctrl--restore={leftOut}
		{onclick}
		aria-label={leftOut ? `Put back ${what}` : `Leave out ${what}`}
		title={leftOut ? 'Put back' : 'Leave out (stays a local draft)'}
	>
		{#if leftOut}
			<ArrowCounterClockwise size={12} weight="bold" />
			<span>Put back</span>
		{:else}
			<X size={13} weight="bold" />
		{/if}
	</button>
{/snippet}

{#snippet issueRow(issue: WalkthroughIssue)}
	{@const leftOut = leftOutIssues.has(issue.id)}
	<li class="row row--issue" data-severity={issue.severity} data-state={leftOut ? 'left-out' : 'kept'}>
		<div class="row-head">
			<span class="row-gutter" aria-hidden="true"></span>
			<span class="severity-code" title={ISSUE_SEVERITY_LABEL[issue.severity]}>
				{SEVERITY_CODE[issue.severity]}
			</span>
			<span class="row-label">
				<span class="issue-title">{issue.title}</span>
			</span>
			{@render rowToggle(leftOut, `the issue ${issue.title}`, () => {
				leftOutIssues = toggled(leftOutIssues, issue.id);
			})}
		</div>
	</li>
{/snippet}

{#snippet threadRow(row: PostableThread)}
	{@const rowAt = rowState(row)}
	{@const shown = posting.get(row.thread.id) ?? row}
	{@const byRevv = shown.messages.some((m) => m.authorRole === 'ai_agent')}
	{@const where = `${row.thread.filePath}${lineRangeLabel(row.thread)}`}
	<li class="row" data-state={rowAt}>
		<div class="row-head">
			<span class="row-gutter" aria-hidden="true"></span>
			<span
				class="row-icon"
				title={row.kind === 'reply' ? 'Reply on a thread already on GitHub' : 'New line comment'}
			>
				{#if row.kind === 'reply'}
					<ArrowBendUpLeft size={13} />
				{:else}
					<Chat size={13} />
				{/if}
			</span>
			<span class="row-label">
				<FileBadge
					filePath={row.thread.filePath}
					startLine={row.thread.startLine}
					endLine={row.thread.endLine}
				/>
				<span class="row-line">{lineRangeLabel(row.thread)}</span>
				{#if byRevv}
					<span class="row-revv" title="Written by the walkthrough agent">
						<Robot size={12} />
						revv
					</span>
				{/if}
			</span>
			{#if rowAt === 'with-issue'}
				<span class="row-aside">with its issue</span>
			{:else}
				{@render rowToggle(rowAt === 'left-out', `the ${row.kind} on ${where}`, () => {
					leftOutThreads = toggled(leftOutThreads, row.thread.id);
				})}
			{/if}
		</div>
		{#if rowAt === 'kept'}
			<div class="row-body">
				{#each shown.bodies as text, i (i)}
					{@const key = `${row.thread.id}:${i}`}
					{@const long = isLong(text)}
					{@const isOpen = expanded.has(key)}
					<div class="body-clip" class:body-clip--clamped={long && !isOpen}>
						<Markdown
							class="row-markdown"
							source={text}
							trust={byRevv && i === 0 ? 'agent' : 'external'}
							density="dense"
						/>
					</div>
					{#if long}
						<button
							type="button"
							class="body-more"
							aria-expanded={isOpen}
							onclick={() => (expanded = toggled(expanded, key))}
						>
							{isOpen ? 'Show less' : 'Show all'}
						</button>
					{/if}
				{/each}
			</div>
		{/if}
	</li>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay>
			{#snippet child({ props })}
				<div
					{...props}
					class="submit-overlay"
					data-glass
					use:bitsAnim={{ inPreset: overlayFadeIn, outPreset: overlayFadeOut }}
				></div>
			{/snippet}
		</Dialog.Overlay>
		<Dialog.Content>
			{#snippet child({ props })}
				<div
					{...props}
					class="submit-content"
					data-glass
					onkeydown={onDialogKeydown}
					use:bitsAnim={{ inPreset: dialogSpringIn, outPreset: dialogSpringOut }}
				>
					<header class="submit-header">
						<span class="tone-tile tone-tile--{ACTIONS[action].tone}" aria-hidden="true">
							{@render actionGlyph(action, 16)}
						</span>
						<div class="submit-heading">
							<Dialog.Title>
								{#snippet child({ props: titleProps })}
									<h2 {...titleProps} class="submit-title">Submit review</h2>
								{/snippet}
							</Dialog.Title>
							<Dialog.Description>
								{#snippet child({ props: descProps })}
									<p {...descProps} class="submit-description">{description}</p>
								{/snippet}
							</Dialog.Description>
						</div>
					</header>

					{#if !commentOnly}
						<SegmentedControl
							options={actionOptions}
							value={action}
							onValueChange={(next) => (action = next)}
							aria-label="Review event"
							class="event-picker"
						/>
					{/if}

					{#if action === 'approve' && unresolvedPhrase}
						<p class="note" in:gsapFadeY={{ duration: tokens.quick, y: 4 }}>
							<Warning size={14} weight="fill" />
							<span>{unresolvedPhrase} still open.</span>
						</p>
					{/if}

					{#if issues.length > 0 || threadRows.length > 0}
						<div class="list">
							<SpecPanel label="What the review posts">
								<ul class="rows">
									{#each issues as issue (issue.id)}
										{@render issueRow(issue)}
									{/each}
									{#each threadRows as row (row.thread.id)}
										{@render threadRow(row)}
									{/each}
								</ul>
							</SpecPanel>
						</div>
					{/if}

					<footer class="submit-footer">
						<p class="footer-note" class:footer-note--blocked={blocker !== null} aria-live="polite">
							{#if blocker}
								{blocker}
							{:else if leftOutCount > 0}
								{leftOutCount === 1 ? '1 item stays a draft' : `${leftOutCount} items stay drafts`}
							{/if}
						</p>
						<Dialog.Close class="btn btn--cancel" disabled={submitting}>Cancel</Dialog.Close>
						<button
							type="button"
							class="btn btn--confirm btn--{ACTIONS[action].tone}"
							disabled={!canConfirm}
							aria-keyshortcuts="Meta+Enter"
							onclick={confirm}
							use:gsapPress={{ disabled: !canConfirm }}
						>
							{#if submitting}
								<Spinner size={13} class="motion-essential-spin" />
								Submitting…
							{:else}
								{ACTIONS[action].confirm}
								<span class="btn-keys" aria-hidden="true">⌘↵</span>
							{/if}
						</button>
					</footer>
				</div>
			{/snippet}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	/* The shell is ConfirmDialog's, grown to hold a list. */
	.submit-overlay {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.submit-content {
		position: fixed;
		top: 12vh;
		left: 0;
		right: 0;
		z-index: 61;
		display: flex;
		flex-direction: column;
		gap: 14px;
		width: min(560px, calc(100vw - 32px));
		max-height: 76vh;
		margin: 0 auto;
		padding: 20px;
		border: 1px solid var(--color-glass-border);
		border-radius: 12px;
		background: var(--color-glass-bg);
		color: var(--color-text-primary);
		backdrop-filter: blur(20px) saturate(1.4);
		-webkit-backdrop-filter: blur(20px) saturate(1.4);
		box-shadow:
			var(--color-shadow-xl),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		outline: none;
	}

	.submit-header {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.tone-tile {
		--tone: var(--color-accent);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 8px;
		background: color-mix(in srgb, var(--tone) 12%, transparent);
		color: var(--tone);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 22%, transparent);
		transition:
			color var(--duration-quick) var(--ease-soft),
			background-color var(--duration-quick) var(--ease-soft),
			box-shadow var(--duration-quick) var(--ease-soft);
	}

	.tone-tile--success {
		--tone: var(--color-success);
	}

	.tone-tile--danger {
		--tone: var(--color-danger);
	}

	.submit-heading {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.submit-title {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		letter-spacing: -0.01em;
		color: var(--color-text-primary);
	}

	.submit-description {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	:global(.submit-content .event-picker) {
		align-self: flex-start;
	}

	.note {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.note :global(svg) {
		flex-shrink: 0;
		color: var(--color-warning);
	}

	/* The one scrolling region; the header and footer stay put. */
	.list {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		border-radius: 10px;
	}

	.list > :global(*) {
		flex-shrink: 0;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	/* Rows take the spec row's metrics: a 2px gutter, 36px head, mono label. */
	.row {
		--row-tone: var(--color-accent);
		position: relative;
		display: flex;
		flex-direction: column;
	}

	.row + .row {
		border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
	}

	.row--issue {
		--row-tone: var(--severity-score-icon);
	}

	.row-gutter {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--row-tone);
		transition: background var(--duration-quick) var(--ease-soft);
	}

	.row:not([data-state='kept']) .row-gutter {
		background: var(--color-border);
	}

	.row-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 0 8px 0 16px;
		min-width: 0;
	}

	.row-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2ch;
		flex-shrink: 0;
		color: var(--color-accent);
	}

	.row-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}

	.row-line {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.row-revv,
	.row-aside {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.row-aside {
		flex-shrink: 0;
		padding-right: 6px;
		font-style: italic;
	}

	.severity-code {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		min-width: 2ch;
		padding: 1px 5px;
		border-radius: 3px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		font-variant-numeric: tabular-nums;
		color: var(--severity-score-label);
		background: color-mix(in srgb, var(--severity-score-bg) 85%, transparent);
		border: 1px solid color-mix(in srgb, var(--severity-score-border) 35%, transparent);
	}

	.issue-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.005em;
		color: var(--color-text-primary);
	}

	.row[data-state='left-out'] .issue-title {
		text-decoration: line-through;
		text-decoration-color: color-mix(in srgb, var(--color-text-muted) 60%, transparent);
	}

	.row:not([data-state='kept']) :is(.row-label, .row-icon, .severity-code) {
		opacity: 0.5;
	}

	.row-label,
	.row-icon,
	.severity-code {
		transition: opacity var(--duration-quick) var(--ease-soft);
	}

	.row-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 0 14px 10px 42px;
		min-width: 0;
	}

	.body-clip :global(.row-markdown) {
		max-width: 65ch;
		color: var(--color-text-secondary);
	}

	.body-clip--clamped {
		max-height: calc(1.55em * 3);
		overflow: hidden;
		mask-image: linear-gradient(to bottom, black 55%, transparent);
		-webkit-mask-image: linear-gradient(to bottom, black 55%, transparent);
	}

	/* Row controls: quiet at rest, full strength on the row being looked at. */
	.row-ctrl {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		gap: 5px;
		height: 24px;
		min-width: 24px;
		padding: 0 6px;
		border: none;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-muted);
		opacity: 0.6;
		cursor: pointer;
		transition:
			opacity var(--duration-snap) var(--ease-soft),
			color var(--duration-snap) var(--ease-soft),
			background-color var(--duration-snap) var(--ease-soft);
	}

	.row:hover .row-ctrl,
	.row:focus-within .row-ctrl {
		opacity: 1;
	}

	.row-ctrl:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-text-primary) 7%, transparent);
	}

	.row-ctrl--restore {
		padding: 0 8px 0 6px;
		color: var(--color-accent);
		opacity: 1;
	}

	.row-ctrl--restore:hover {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.body-more {
		align-self: flex-start;
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 500;
		color: var(--color-accent);
		cursor: pointer;
	}

	.body-more:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.body-more:focus-visible,
	.row-ctrl:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
		opacity: 1;
	}

	.submit-footer {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.footer-note {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.footer-note--blocked {
		color: var(--color-warning);
	}

	/* DESIGN.md buttons: 32px, 8px radius, 13px/500. Cancel is the quiet
	   ghost; the confirm takes the review's tone, and Request changes stays
	   tinted (never a solid red). */
	.submit-footer :global(.btn) {
		--btn-tone: var(--color-accent);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.005em;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--duration-snap) var(--ease-soft),
			border-color var(--duration-snap) var(--ease-soft),
			color var(--duration-snap) var(--ease-soft),
			opacity var(--duration-snap) var(--ease-soft);
	}

	.submit-footer :global(.btn:focus-visible) {
		outline: 2px solid color-mix(in srgb, var(--btn-tone) 60%, transparent);
		outline-offset: 2px;
	}

	.submit-footer :global(.btn:disabled) {
		cursor: default;
		opacity: 0.45;
	}

	.submit-footer :global(.btn--cancel) {
		color: var(--color-text-secondary);
	}

	.submit-footer :global(.btn--cancel:hover:not(:disabled)) {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-text-primary) 7%, transparent);
	}

	.submit-footer .btn--confirm {
		min-width: 128px;
		padding: 0 10px 0 14px;
		background: var(--btn-tone);
		color: var(--color-bg-primary);
	}

	.submit-footer .btn--confirm:hover:not(:disabled) {
		background: color-mix(in srgb, var(--btn-tone) 88%, var(--color-text-primary));
	}

	.submit-footer .btn--success {
		--btn-tone: var(--color-success);
	}

	.submit-footer .btn--danger {
		--btn-tone: var(--color-danger);
		background: color-mix(in srgb, var(--btn-tone) 10%, transparent);
		border-color: color-mix(in srgb, var(--btn-tone) 28%, transparent);
		color: var(--btn-tone);
	}

	.submit-footer .btn--danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--btn-tone) 18%, transparent);
	}

	.btn-keys {
		padding: 0 5px;
		border-radius: 4px;
		background: color-mix(in srgb, currentColor 16%, transparent);
		font-size: 11px;
		line-height: 18px;
		letter-spacing: 0.04em;
		opacity: 0.85;
	}
</style>
