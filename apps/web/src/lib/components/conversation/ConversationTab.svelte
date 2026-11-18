<script lang="ts">
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import { untrack } from "svelte";
import YourReview from "$lib/components/review/YourReview.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { prefersReducedMotion } from "$lib/motion";
import { useCommands } from "$lib/stores/commands.svelte";
import {
  editBody,
  getAbilities,
  getConversation,
  loadConversation,
  postComment,
  watchConversation,
} from "$lib/stores/conversation.svelte";
import { getConversationSeenAt, setConversationSeenAt } from "$lib/stores/conversation-seen.svelte";
import { getActivePanel } from "$lib/stores/focus-mode.svelte";
import { useMergeEligibility } from "$lib/stores/merge-eligibility.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
import BaseConflicts from "./BaseConflicts.svelte";
import CiChecks from "./CiChecks.svelte";
import ConversationSidebar from "./ConversationSidebar.svelte";
import MarkdownEditor from "./MarkdownEditor.svelte";
import PrDescription from "./PrDescription.svelte";
import PrPulse from "./PrPulse.svelte";
import { itemsSince, prPulse } from "./pr-pulse";
import Timeline from "./Timeline.svelte";

interface Props {
  prId: string;
  isActive: boolean;
}

let { prId, isActive }: Props = $props();

const entry = $derived(getConversation(prId));
const conversation = $derived(entry.request.status === "ok" ? entry.request.data : null);
const abilities = $derived(getAbilities(prId));
// Maintainers may edit anyone's description on GitHub; here only its author
// can, so a click in someone else's text never rewrites it.
const canEditBody = $derived(
  abilities.canEdit &&
    !!conversation &&
    conversation.viewerLogin.toLowerCase() === conversation.author.login.toLowerCase(),
);

// ── Overview ────────────────────────────────────────────────────────────
const pr = $derived(getPrById(prId));
const baseRef = $derived(pr?.targetBranch ?? "the base branch");
// Mergeability only means something for an open, ready PR.
const mergeable = $derived(
  !!conversation && conversation.state === "open" && !conversation.isDraft,
);
const mergeEligibility = useMergeEligibility(
  () => prId,
  () => isActive && mergeable,
);
const pulse = $derived(
  conversation ? prPulse(conversation, mergeable ? mergeEligibility.current : null, baseRef) : null,
);

// What happened since the last visit. The baseline is read once when the tab
// comes on screen; the store moves on to the newest item straight away, so the
// marks hold for this visit and the next one starts from here.
let seenBaseline = $state<string | null>(null);
$effect(() => {
  if (!isActive || !prId) return;
  const id = prId;
  untrack(() => {
    seenBaseline = getConversationSeenAt(id);
  });
});
$effect(() => {
  const newest = conversation?.timeline.at(-1)?.createdAt;
  if (!isActive || !newest) return;
  const id = prId;
  untrack(() => setConversationSeenAt(id, newest));
});
const fresh = $derived(
  conversation ? itemsSince(conversation.timeline, seenBaseline, conversation.viewerLogin) : [],
);

// Failing or running checks open by themselves; settled ones wait for a click.
let checksChoice = $state<boolean | null>(null);
const checksNeedYou = $derived(pulse?.checks.tone === "bad" || pulse?.checks.tone === "pending");
const checksOpen = $derived(checksChoice ?? checksNeedYou);
$effect(() => {
  void prId;
  checksChoice = null;
});

function reveal(target: Element | null | undefined): void {
  target?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

let root = $state<HTMLDivElement | null>(null);
const find = (selector: string) => root?.querySelector(selector);

let composer = $state<HTMLTextAreaElement | null>(null);
let reviewersOpen = $state(false);
let assigneesOpen = $state(false);
let labelsOpen = $state(false);

$effect(() => {
  if (!isActive || !prId) return;
  const id = prId;
  return untrack(() => watchConversation(id));
});

// The sidebar's file tree binds the same letters (`l` opens a file).
const keysLive = (): boolean => isActive && conversation !== null && getActivePanel() !== "sidebar";
const canEdit = (): boolean => keysLive() && abilities.canEdit;

function focusComposer(): void {
  if (!composer) return;
  composer.focus();
  composer.scrollIntoView({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

useCommands([
  {
    id: "conversation:comment",
    label: "Write a comment",
    keys: { bare: ["c", "C"] },
    when: () => keysLive() && abilities.canComment && composer !== null,
    hidden: true,
    run: focusComposer,
  },
  {
    id: "conversation:reviewers",
    label: "Edit reviewers",
    keys: { bare: ["r", "R"] },
    when: canEdit,
    hidden: true,
    run: () => {
      reviewersOpen = true;
    },
  },
  {
    id: "conversation:assignees",
    label: "Edit assignees",
    keys: { bare: ["a", "A"] },
    when: canEdit,
    hidden: true,
    run: () => {
      assigneesOpen = true;
    },
  },
  {
    id: "conversation:labels",
    label: "Edit labels",
    keys: { bare: ["l", "L"] },
    when: canEdit,
    hidden: true,
    run: () => {
      labelsOpen = true;
    },
  },
]);
</script>

<div class="conversation review-columns" bind:this={root}>
	{#if pulse}
		<div class="slot-pulse">
			<PrPulse
				{pulse}
				{fresh}
				seenAt={seenBaseline}
				{checksOpen}
				onChecks={() => (checksChoice = !checksOpen)}
				onReviews={() => reveal(find('#side-reviewers')?.closest('section'))}
				onMerge={pulse.merge.tone === 'bad' ? () => reveal(find('.slot-conflicts')) : undefined}
				onActivity={() => reveal(find('#activity-heading'))}
				onFresh={() => reveal(find('[data-fresh]'))}
			/>
		</div>
	{/if}
	<div class="conversation-main">
		{#if conversation}
			{#if entry.stale}
				<p class="conversation-stale" role="status">
					GitHub couldn't be reached. Showing the copy from {formatRelativeTime(conversation.fetchedAt)}.
					<Button variant="ghost" size="xs" onclick={() => void loadConversation(prId, { force: true })}>
						<ArrowClockwise />Retry
					</Button>
				</p>
			{/if}

			<!-- Where CI stands now, first thing on the page. Each commit in the
			     activity below carries its own CI state. -->
			{#if checksOpen}
			<div class="slot-checks">
				<CiChecks {prId} {conversation} />
			</div>
			{/if}

			<div class="slot-conflicts">
				<BaseConflicts {prId} {conversation} />
			</div>

			<div class="slot-description">
				{#key prId}
					<PrDescription
						body={conversation.body}
						onsave={canEditBody ? (body) => editBody(prId, body) : undefined}
					/>
				{/key}
			</div>
		{:else if entry.request.status === 'error'}
			<div class="conversation-error" role="alert">
				<p>Couldn't load the conversation: {entry.request.error}</p>
				<div class="conversation-error-actions">
					<Button variant="outline" size="sm" onclick={() => void loadConversation(prId, { force: true })}>
						<ArrowClockwise />Retry
					</Button>
				</div>
			</div>
		{:else}
			<div class="conversation-skeleton" aria-busy="true" aria-label="Loading conversation">
				<div class="skeleton-card"><span class="skeleton-line skeleton-line--head"></span></div>
				<div class="skeleton-body">
					<span class="skeleton-line skeleton-line--head"></span>
					<span class="skeleton-line"></span>
					<span class="skeleton-line skeleton-line--short"></span>
				</div>
			</div>
		{/if}

		<section class="slot-section" aria-labelledby="your-review-heading">
			<h2 id="your-review-heading" class="section-heading">Your review</h2>
			<YourReview {prId} />
		</section>

		<!-- The history comes last, ending where the next comment goes. -->
		{#if conversation}
			<section class="slot-section" aria-labelledby="activity-heading">
				<h2 id="activity-heading" class="section-heading">Activity</h2>
				<Timeline {prId} {conversation} freshSince={seenBaseline} />
				{#if abilities.canComment && conversation.state === 'open'}
					<div class="activity-composer">
						<MarkdownEditor
							placeholder="Add a comment"
							submitLabel="Comment"
							onsubmit={(body) => postComment(prId, body)}
							bind:textarea={composer}
						/>
					</div>
				{/if}
			</section>
		{/if}
	</div>

	<aside class="conversation-side" data-col="rail" aria-label="Pull request details">
		{#if conversation}
			<ConversationSidebar
				{prId}
				{conversation}
				bind:reviewersOpen
				bind:assigneesOpen
				bind:labelsOpen
			/>
			<button type="button" class="side-github" onclick={() => void openExternal(conversation.url)}>
				<ArrowSquareOut size={13} />
				Open on GitHub
			</button>
		{/if}
	</aside>
</div>

<style>
	/* The review grid (review-columns.css): the timeline in the content
	   column, the sidebar in the rail. */
	.conversation {
		align-items: start;
		/* Clears the floating review action bar. */
		padding: 16px 0 100px;
		background: var(--color-bg-primary);
	}

	.slot-conflicts:empty {
		display: none;
	}

	/* The overview spans the reading column and the rail: it's about the
	   whole PR, and everything under it is the detail. */
	.slot-pulse {
		margin-bottom: 28px;
		container: pulse / inline-size;
	}

	/* Out-specifies review-columns' placement rules, which put every child in
	   one column. */
	.conversation > .slot-pulse {
		grid-column: 3 / 6;
		grid-row: 1;
	}

	.conversation > .conversation-main,
	.conversation > .conversation-side {
		grid-row: 2;
	}

	.conversation-main {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}

	.conversation-side {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding-top: 4px;
	}

	.slot-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 16px;
		padding-top: 24px;
		border-top: 1px solid var(--color-border);
	}

	.activity-composer {
		margin-top: 8px;
	}

	.section-heading {
		margin: 0;
		font-size: var(--text-lg);
		letter-spacing: var(--text-lg--letter-spacing);
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.conversation-stale {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 6px 6px 6px 12px;
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--color-warning) 8%, transparent);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.conversation-error {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.conversation-error p {
		margin: 0;
	}

	.conversation-error-actions {
		display: flex;
		gap: 8px;
	}

	.conversation-skeleton {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.skeleton-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 7px;
	}

	.skeleton-card {
		padding: 14px 16px;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
	}

	.skeleton-line {
		display: block;
		height: 10px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
	}

	.skeleton-line--head {
		width: 40%;
	}

	.skeleton-line--short {
		width: 60%;
	}

	.side-github {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		padding: 8px 0 0;
		border: none;
		border-top: 1px solid var(--color-border-subtle);
		background: none;
		width: 100%;
		font: inherit;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.side-github:hover {
		color: var(--color-text-primary);
	}

	/* Narrow main area: one column. The main column dissolves into the flex
	   flow so the sidebar can slot in right under the description, where
	   GitHub's mobile layout puts it. Gated on `.review-content`'s width,
	   not the viewport (the sidebar and right panel both move it). */
	@container review (max-width: 1335px) {
		/* Left edge pinned at col_3's x (72px), like the title and the
		   walkthrough's narrow layout, so all three stay aligned. */
		.conversation {
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 16px;
			max-width: calc(72px + 820px + 32px);
			margin-inline: 0;
			padding: 16px 32px 100px 72px;
			box-sizing: border-box;
		}

		.conversation-main {
			display: contents;
		}

		.slot-pulse {
			order: -1;
			margin-bottom: 12px;
		}

		.conversation-stale,
		.slot-checks,
		.slot-conflicts,
		.slot-description {
			order: 0;
		}

		.conversation-side {
			order: 1;
			container: side / inline-size;
			padding: 12px 14px;
			border: 1px solid var(--color-border-subtle);
			border-radius: var(--radius-card);
			background: var(--color-bg-secondary);
		}

		.slot-section,
		.conversation-error,
		.conversation-skeleton {
			order: 2;
		}
	}
</style>
