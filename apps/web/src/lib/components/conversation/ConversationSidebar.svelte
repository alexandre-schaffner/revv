<script lang="ts">
import type { PrConversation, PrLabel, ReviewerEntry } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import Circle from "phosphor-svelte/lib/Circle";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import ShieldCheck from "phosphor-svelte/lib/ShieldCheck";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import {
  loadAssigneeOptions,
  loadLabelOptions,
  loadReviewerOptions,
} from "$lib/stores/conversation.svelte";
import type { ReviewerChange } from "$lib/utils/conversation-patches";
import { openExternal } from "$lib/utils/open-external";
import CodeOwnersSection from "./CodeOwnersSection.svelte";
import LabelChip from "./LabelChip.svelte";
import MetaPicker, { type PickerOption } from "./MetaPicker.svelte";
import StackSection from "./StackSection.svelte";
import VerdictGlyph, { VERDICT_LABEL } from "./VerdictGlyph.svelte";

interface Props {
  prId: string;
  conversation: PrConversation;
  canEdit: boolean;
  onReviewers: (added: ReviewerChange, removed: ReviewerChange) => void;
  onAssignees: (added: string[], removed: string[]) => void;
  onLabels: (added: PrLabel[], removed: string[]) => void;
  reviewersOpen?: boolean;
  assigneesOpen?: boolean;
  labelsOpen?: boolean;
}

let {
  prId,
  conversation,
  canEdit,
  onReviewers,
  onAssignees,
  onLabels,
  reviewersOpen = $bindable(false),
  assigneesOpen = $bindable(false),
  labelsOpen = $bindable(false),
}: Props = $props();

/** Who a review can be requested from. */
type ReviewerRef =
  | { readonly kind: "user"; readonly login: string }
  | { readonly kind: "team"; readonly combinedSlug: string };

const refOf = (r: ReviewerEntry): ReviewerRef =>
  r.kind === "team"
    ? { kind: "team", combinedSlug: r.combinedSlug }
    : { kind: "user", login: r.actor.login };
const refKey = (r: ReviewerRef) =>
  r.kind === "team" ? `team:${r.combinedSlug}` : `user:${r.login}`;
const reviewerKey = (r: ReviewerEntry) => refKey(refOf(r));

function changeOf(refs: readonly ReviewerRef[]): ReviewerChange {
  return {
    users: refs.flatMap((r) => (r.kind === "user" ? [r.login] : [])),
    teams: refs.flatMap((r) => (r.kind === "team" ? [r.combinedSlug] : [])),
  };
}

const NO_CHANGE: ReviewerChange = { users: [], teams: [] };

const requestedReviewers = $derived(
  new Map(
    conversation.reviewers
      .filter((r) => r.requested)
      .map((r) => [reviewerKey(r), refOf(r)] as const),
  ),
);
const assigneeLogins = $derived(new Map(conversation.assignees.map((a) => [a.login, a.login])));
const appliedLabels = $derived(new Map(conversation.labels.map((l) => [l.name, l])));

const DECISION: Record<NonNullable<PrConversation["reviewDecision"]>, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "An approving review is required to merge",
};

async function reviewerOptions(q: string): Promise<PickerOption<ReviewerRef>[]> {
  const { users, teams } = await loadReviewerOptions(prId, q);
  return [
    ...teams.map(
      (t): PickerOption<ReviewerRef> => ({
        key: refKey({ kind: "team", combinedSlug: t.combinedSlug }),
        item: { kind: "team", combinedSlug: t.combinedSlug },
        title: t.name,
        section: "Teams",
        hint: t.combinedSlug,
        leading: { kind: "team" },
      }),
    ),
    ...users.map(
      (u): PickerOption<ReviewerRef> => ({
        key: refKey({ kind: "user", login: u.login }),
        item: { kind: "user", login: u.login },
        title: u.login,
        section: "People",
        hint: u.name,
        leading: { kind: "user", avatarContent: u.avatarContent },
      }),
    ),
  ];
}

async function assigneeOptions(q: string): Promise<PickerOption<string>[]> {
  const users = await loadAssigneeOptions(prId, q);
  return users.map((u) => ({
    key: u.login,
    item: u.login,
    title: u.login,
    section: "People",
    hint: u.name,
    leading: { kind: "user", avatarContent: u.avatarContent },
  }));
}

async function labelOptions(): Promise<PickerOption<PrLabel>[]> {
  const labels = await loadLabelOptions(prId);
  return labels.map((l) => ({
    key: l.name,
    item: l,
    title: l.name,
    section: "Labels",
    hint: l.description,
    leading: { kind: "label", label: l },
  }));
}
</script>

{#snippet codeOwnerMark()}
	<span class="side-codeowner" title="Requested as a code owner" aria-label="Code owner">
		<ShieldCheck size={13} />
	</span>
{/snippet}

<div class="sidebar">
	{#if conversation.stack}
		<div class="side-section side-section--stack">
			<StackSection stack={conversation.stack} number={conversation.number} />
		</div>
	{/if}

	<section class="side-section" aria-labelledby="side-reviewers">
		<header class="side-head">
			<h3 id="side-reviewers">Reviewers</h3>
			{#if canEdit}
				<MetaPicker
					label="Edit reviewers"
					title="Request reviews"
					placeholder="Search people and teams"
					selected={requestedReviewers}
					load={reviewerOptions}
					remote
					onapply={(added, removed) => onReviewers(changeOf(added), changeOf(removed))}
					bind:open={reviewersOpen}
				/>
			{/if}
		</header>
		{#if conversation.reviewers.length === 0}
			<p class="side-empty">No reviews requested</p>
		{:else}
			<ul class="side-list">
				{#each conversation.reviewers as reviewer (reviewerKey(reviewer))}
					<li class="side-person">
						{#if reviewer.kind === 'team'}
							<span class="side-team"><UsersThree size={13} /></span>
							<span class="side-name" title={reviewer.combinedSlug}>{reviewer.name}</span>
							{#if reviewer.asCodeOwner}{@render codeOwnerMark()}{/if}
							<span class="side-state" title="Awaiting review">
								<CircleDashed size={14} weight="bold" class="side-awaiting" />
							</span>
						{:else}
							{@const login = reviewer.actor.login}
							<Avatar handle={login} avatarContent={reviewer.actor.avatarContent} size={20} />
							<span class="side-name">{login}</span>
							{#if reviewer.asCodeOwner}{@render codeOwnerMark()}{/if}
							{#if canEdit && reviewer.verdict !== null && !reviewer.requested}
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="Re-request review from {login}"
									title="Re-request review"
									onclick={() => onReviewers({ users: [login], teams: [] }, NO_CHANGE)}
								>
									<ArrowsClockwise />
								</Button>
							{/if}
							<span
								class="side-state"
								title={reviewer.verdict ? VERDICT_LABEL[reviewer.verdict] : 'Awaiting review'}
							>
								{#if reviewer.verdict && !(reviewer.requested && reviewer.verdict === 'commented')}
									<VerdictGlyph verdict={reviewer.verdict} size={14} />
								{:else}
									<CircleDashed size={14} weight="bold" class="side-awaiting" />
								{/if}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if conversation.reviewDecision}
			<p class="side-note side-note--{conversation.reviewDecision}">
				{DECISION[conversation.reviewDecision]}
			</p>
		{/if}
	</section>

	{#if conversation.codeowners}
		<div class="side-section">
			<CodeOwnersSection
				codeowners={conversation.codeowners}
				reviewers={conversation.reviewers}
				avatars={conversation.avatars}
			/>
		</div>
	{/if}

	<section class="side-section" aria-labelledby="side-assignees">
		<header class="side-head">
			<h3 id="side-assignees">Assignees</h3>
			{#if canEdit}
				<MetaPicker
					label="Edit assignees"
					title="Assign"
					placeholder="Search people"
					selected={assigneeLogins}
					load={assigneeOptions}
					remote
					onapply={onAssignees}
					bind:open={assigneesOpen}
				/>
			{/if}
		</header>
		{#if conversation.assignees.length === 0}
			<p class="side-empty">
				<span>No one</span>
				{#if canEdit}
					<span aria-hidden="true">·</span>
					<button
						type="button"
						class="side-link"
						onclick={() => onAssignees([conversation.viewerLogin], [])}
					>
						Assign yourself
					</button>
				{/if}
			</p>
		{:else}
			<ul class="side-list">
				{#each conversation.assignees as assignee (assignee.login)}
					<li class="side-person">
						<Avatar handle={assignee.login} avatarContent={assignee.avatarContent} size={20} />
						<span class="side-name">{assignee.login}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="side-section" aria-labelledby="side-labels">
		<header class="side-head">
			<h3 id="side-labels">Labels</h3>
			{#if canEdit}
				<MetaPicker
					label="Edit labels"
					title="Apply labels"
					placeholder="Search labels"
					selected={appliedLabels}
					load={labelOptions}
					onapply={(added, removed) => onLabels(added, removed.map((l) => l.name))}
					bind:open={labelsOpen}
				/>
			{/if}
		</header>
		{#if conversation.labels.length === 0}
			<p class="side-empty">None</p>
		{:else}
			<div class="side-labels">
				{#each conversation.labels as label (label.name)}
					<LabelChip {label} />
				{/each}
			</div>
		{/if}
	</section>

	{#if conversation.milestone}
		{@const milestone = conversation.milestone}
		<section class="side-section" aria-labelledby="side-milestone">
			<header class="side-head"><h3 id="side-milestone">Milestone</h3></header>
			<button type="button" class="side-link side-row" onclick={() => void openExternal(milestone.url)}>
				{milestone.title}
				{#if milestone.dueOn}
					<span class="side-muted">due {new Date(milestone.dueOn).toLocaleDateString()}</span>
				{/if}
			</button>
		</section>
	{/if}

	{#if conversation.linkedIssues.length > 0}
		<section class="side-section" aria-labelledby="side-issues">
			<header class="side-head"><h3 id="side-issues">Closes</h3></header>
			<ul class="side-list">
				{#each conversation.linkedIssues as issue (issue.url)}
					<li>
						<button type="button" class="side-link side-row" onclick={() => void openExternal(issue.url)}>
							{#if issue.state === 'closed'}
								<CheckCircle size={14} class="side-issue-closed" aria-label="Closed" />
							{:else}
								<Circle size={14} class="side-issue-open" aria-label="Open" />
							{/if}
							<span class="side-issue-title">{issue.title}</span>
							<span class="side-muted">#{issue.number}</span>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if conversation.participants.length > 0}
		<section class="side-section" aria-labelledby="side-participants">
			<header class="side-head">
				<h3 id="side-participants">{conversation.participants.length} participants</h3>
			</header>
			<div class="side-avatars">
				{#each conversation.participants as person (person.login)}
					<span title={person.login}>
						<Avatar handle={person.login} avatarContent={person.avatarContent} size={24} />
					</span>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
	}

	.side-section {
		padding: 12px 0;
	}

	.side-section + .side-section {
		border-top: 1px solid var(--color-border-subtle);
	}

	.side-section:first-child {
		padding-top: 0;
	}

	.side-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 24px;
		margin-bottom: 6px;
		color: var(--color-text-secondary);
	}

	.side-head h3 {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

	.side-empty,
	.side-note {
		display: flex;
		align-items: baseline;
		gap: 5px;
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.side-note {
		margin-top: 8px;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.side-note--approved {
		color: var(--color-success);
	}

	.side-note--changes_requested {
		color: var(--color-danger);
	}

	.side-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.side-person {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 28px;
	}

	.side-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.side-codeowner {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.side-team {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 5px;
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.side-state {
		display: inline-flex;
		width: 16px;
		justify-content: center;
	}

	.side-state :global(.side-awaiting) {
		color: var(--color-warning);
	}

	.side-labels {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.side-link {
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		text-align: left;
		cursor: pointer;
	}

	.side-link:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}

	.side-row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-height: 26px;
		color: var(--color-text-primary);
	}

	.side-issue-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.side-row :global(.side-issue-open) {
		flex-shrink: 0;
		color: var(--color-success);
	}

	.side-row :global(.side-issue-closed) {
		flex-shrink: 0;
		color: var(--color-merged);
	}

	.side-muted {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.side-avatars {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	/* Inline above the timeline (narrow main area), the sections pair up
	   into two columns instead of stacking into a tall strip. */
	@container side (min-width: 520px) {
		.sidebar {
			display: grid;
			grid-template-columns: 1fr 1fr;
			column-gap: 28px;
		}

		.side-section--stack {
			grid-column: 1 / -1;
		}

		/* Without a stack, the second section starts the right column. */
		.side-section:nth-child(2):not(.side-section--stack + .side-section) {
			padding-top: 0;
			border-top: none;
		}
	}
</style>
