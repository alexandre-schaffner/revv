<script lang="ts">
import type { ConversationActor } from "@revv/shared";
import ArrowsCounterClockwise from "phosphor-svelte/lib/ArrowsCounterClockwise";
import Eye from "phosphor-svelte/lib/Eye";
import FileDashed from "phosphor-svelte/lib/FileDashed";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import Prohibit from "phosphor-svelte/lib/Prohibit";
import Stack from "phosphor-svelte/lib/Stack";
import Tag from "phosphor-svelte/lib/Tag";
import UserMinus from "phosphor-svelte/lib/UserMinus";
import UserPlus from "phosphor-svelte/lib/UserPlus";
import XCircle from "phosphor-svelte/lib/XCircle";
import Avatar from "$lib/components/shared/Avatar.svelte";
import type { EventLine } from "$lib/utils/conversation-timeline";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
import LabelChip from "./LabelChip.svelte";

interface Props {
  line: EventLine;
}

let { line }: Props = $props();

const actor: ConversationActor = $derived(line.kind === "single" ? line.event.actor : line.actor);
const createdAt = $derived(line.kind === "single" ? line.event.createdAt : line.createdAt);
const event = $derived(line.kind === "single" ? line.event : null);

const short = (sha: string | null) => sha?.slice(0, 7) ?? "unknown";
const list = (names: readonly string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
</script>

<li class="event">
	<span
		class="event-icon"
		class:event-icon--merged={event?.kind === 'merged'}
		class:event-icon--closed={event?.kind === 'closed'}
		class:event-icon--open={event?.kind === 'reopened' || event?.kind === 'ready_for_review'}
		aria-hidden="true"
	>
		{#if line.kind === 'labels'}
			<Tag size={14} />
		{:else if line.kind === 'review_requests'}
			<Eye size={14} />
		{:else if event?.kind === 'assigned'}
			<UserPlus size={14} />
		{:else if event?.kind === 'unassigned'}
			<UserMinus size={14} />
		{:else if event?.kind === 'review_dismissed'}
			<Prohibit size={14} />
		{:else if event?.kind === 'force_pushed'}
			<ArrowsCounterClockwise size={14} />
		{:else if event?.kind === 'ready_for_review' || event?.kind === 'reopened'}
			<GitPullRequest size={14} />
		{:else if event?.kind === 'converted_to_draft'}
			<FileDashed size={14} />
		{:else if event?.kind === 'merged'}
			<GitMerge size={14} weight="bold" />
		{:else if event?.kind === 'closed'}
			<XCircle size={14} />
		{:else if event?.kind === 'renamed'}
			<PencilSimple size={14} />
		{:else if event?.kind === 'added_to_stack' || event?.kind === 'removed_from_stack'}
			<Stack size={14} />
		{:else}
			<LinkSimple size={14} />
		{/if}
	</span>

	<p class="event-text">
		<span class="event-actor">
			{#if actor.kind !== 'ghost'}
				<Avatar handle={actor.login} avatarContent={actor.avatarContent} size={16} />
			{/if}
			<strong>{actor.login}</strong>
		</span>
		{#if line.kind === 'labels'}
			{#if line.added.length > 0}
				added
				{#each line.added as label (label.name)}<LabelChip {label} />{/each}
			{/if}
			{#if line.removed.length > 0}
				{line.added.length > 0 ? 'and removed' : 'removed'}
				{#each line.removed as label (label.name)}<LabelChip {label} />{/each}
			{/if}
			{line.added.length + line.removed.length === 1 ? 'label' : 'labels'}
		{:else if line.kind === 'review_requests'}
			{#if line.requested.length > 0}
				requested a review from <strong>{list(line.requested)}</strong>
			{/if}
			{#if line.removed.length > 0}
				{line.requested.length > 0 ? 'and removed' : 'removed'} the request for
				<strong>{list(line.removed)}</strong>
			{/if}
		{:else if event?.kind === 'assigned'}
			{#if event.assignee === actor.login}self-assigned this{:else}assigned <strong>{event.assignee}</strong>{/if}
		{:else if event?.kind === 'unassigned'}
			{#if event.assignee === actor.login}removed their assignment{:else}unassigned <strong>{event.assignee}</strong>{/if}
		{:else if event?.kind === 'review_dismissed'}
			dismissed {event.reviewer ? `${event.reviewer}'s` : 'a'} review{#if event.message}: <span class="event-quote">{event.message}</span>{/if}
		{:else if event?.kind === 'force_pushed'}
			force-pushed from <code>{short(event.beforeSha)}</code> to <code>{short(event.afterSha)}</code>
		{:else if event?.kind === 'ready_for_review'}
			marked this ready for review
		{:else if event?.kind === 'converted_to_draft'}
			converted this to a draft
		{:else if event?.kind === 'merged'}
			merged <code>{short(event.commitSha)}</code> into <code>{event.baseRef}</code>
		{:else if event?.kind === 'closed'}
			closed this
		{:else if event?.kind === 'reopened'}
			reopened this
		{:else if event?.kind === 'renamed'}
			renamed this from <del>{event.from}</del> to <span class="event-quote">{event.to}</span>
		{:else if event?.kind === 'added_to_stack'}
			added this to stack <strong>#{event.stackNumber}</strong>
		{:else if event?.kind === 'removed_from_stack'}
			removed this from stack <strong>#{event.stackNumber}</strong>
		{:else if event?.kind === 'cross_referenced'}
			mentioned this in
			<button class="event-link" type="button" onclick={() => void openExternal(event.source.url)}>
				{event.source.repo}#{event.source.number} {event.source.title}
			</button>
		{/if}
		<time datetime={createdAt} title={new Date(createdAt).toLocaleString()}>
			{formatRelativeTime(createdAt)}
		</time>
	</p>
</li>

<style>
	.event {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 5px 0;
	}

	.event-icon {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--color-bg-secondary);
		box-shadow: 0 0 0 3px var(--color-bg-primary);
		color: var(--color-text-secondary);
	}

	.event-icon--merged {
		background: var(--color-merged);
		color: var(--color-bg-primary);
	}

	.event-icon--closed {
		background: var(--color-danger);
		color: var(--color-bg-primary);
	}

	.event-icon--open {
		background: var(--color-success);
		color: var(--color-bg-primary);
	}

	.event-text {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 5px;
		min-width: 0;
		margin: 0;
		padding-top: 2px;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.event-actor {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.event-text strong {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.event-text code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-primary);
	}

	.event-quote {
		color: var(--color-text-primary);
	}

	.event-text time {
		color: var(--color-text-muted);
	}

	.event-link {
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		color: var(--color-text-primary);
		text-align: left;
		cursor: pointer;
	}

	.event-link:hover {
		text-decoration: underline;
	}
</style>
