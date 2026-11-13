<script lang="ts">
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
import type { Component } from "svelte";
import Avatar from "$lib/components/shared/Avatar.svelte";
import RelativeTime from "$lib/components/shared/RelativeTime.svelte";
import { describeEvent, type EventIcon, type EventLine } from "$lib/conversation/timeline";
import { openExternal } from "$lib/utils/open-external";
import LabelChip from "./LabelChip.svelte";
import TimelineRow from "./TimelineRow.svelte";

interface Props {
  line: EventLine;
}

let { line }: Props = $props();

const ICONS: Record<EventIcon, Component<{ size?: number; weight?: "bold" }>> = {
  labels: Tag,
  "review-requests": Eye,
  assigned: UserPlus,
  unassigned: UserMinus,
  dismissed: Prohibit,
  "force-pushed": ArrowsCounterClockwise,
  "pull-request": GitPullRequest,
  draft: FileDashed,
  merged: GitMerge,
  closed: XCircle,
  renamed: PencilSimple,
  stack: Stack,
  reference: LinkSimple,
};

const actor = $derived(line.kind === "single" ? line.event.actor : line.actor);
const createdAt = $derived(line.kind === "single" ? line.event.createdAt : line.createdAt);
const described = $derived(describeEvent(line, actor.login));
const Icon = $derived(ICONS[described.icon]);
</script>

<TimelineRow tone={described.tone}>
	{#snippet glyph()}
		{#if described.icon === 'merged'}<Icon size={14} weight="bold" />{:else}<Icon size={14} />{/if}
	{/snippet}
	<p class="event-text">
		<span class="event-actor">
			{#if actor.kind !== 'ghost'}
				<Avatar name={actor.login} src={actor.avatarContent} size={16} />
			{/if}
			<strong>{actor.login}</strong>
		</span>
		{#each described.phrases as phrase, i (i)}
			{#if phrase.kind === 'text'}{phrase.text}
			{:else if phrase.kind === 'strong'}<strong>{phrase.text}</strong>
			{:else if phrase.kind === 'code'}<code>{phrase.text}</code>
			{:else if phrase.kind === 'del'}<del>{phrase.text}</del>
			{:else if phrase.kind === 'quote'}<span class="event-quote">{phrase.text}</span>
			{:else if phrase.kind === 'labels'}{#each phrase.labels as label (label.name)}<LabelChip {label} />{/each}
			{:else if phrase.kind === 'link'}
				{@const url = phrase.url}
				<button class="event-link" type="button" onclick={() => void openExternal(url)}>{phrase.text}</button>
			{/if}
		{/each}
		<RelativeTime iso={createdAt} muted />
	</p>
</TimelineRow>

<style>
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
