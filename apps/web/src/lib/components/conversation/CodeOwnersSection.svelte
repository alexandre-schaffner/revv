<script lang="ts">
import { loginsMatch, type PrConversation, type ReviewerEntry } from "@revv/shared";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/shared/Avatar.svelte";
import DisclosureCaret from "$lib/components/shared/DisclosureCaret.svelte";
import { type OwnerGroup, reviewOwnership } from "$lib/conversation/codeowners-review";
import { gsapSlide } from "$lib/motion";
import { getChangedPaths } from "$lib/stores/diff-files.svelte";
import { openInDiff } from "$lib/stores/review-nav.svelte";
import SidebarSection from "./SidebarSection.svelte";
import VerdictGlyph from "./VerdictGlyph.svelte";

// Who CODEOWNERS makes responsible for this PR's files, read from the base
// branch's CODEOWNERS and matched against the changed files. Each owner
// carries where its approval stands: a user's own verdict, or for a team,
// the members who answered on its behalf.

interface Props {
  prId: string;
  /** Renders nothing while `conversation.codeowners` is null. */
  conversation: PrConversation;
}

let { prId, conversation }: Props = $props();

/** CODEOWNERS handles needn't match a login's case. */
const avatarsByHandle = $derived(
  new Map(
    Object.entries(conversation.avatars).map(([login, content]) => [login.toLowerCase(), content]),
  ),
);

interface OwnerRow extends OwnerGroup {
  readonly name: string;
  readonly reviewer: ReviewerEntry | null;
  readonly avatarContent: string | null;
}

const paths = $derived(getChangedPaths(prId));
const ownership = $derived(reviewOwnership(conversation, paths));

const rows = $derived.by((): OwnerRow[] =>
  ownership.groups.map((group): OwnerRow => {
    const handle = group.handle.toLowerCase();
    const reviewer =
      conversation.reviewers.find((r) =>
        r.kind === "team"
          ? group.team && r.combinedSlug.toLowerCase() === handle
          : !group.team && loginsMatch(r.actor.login, handle),
      ) ?? null;
    return {
      ...group,
      name: reviewer?.kind === "team" ? reviewer.name : group.handle,
      reviewer,
      avatarContent:
        (reviewer?.kind === "user" ? reviewer.actor.avatarContent : null) ??
        avatarsByHandle.get(handle) ??
        null,
    };
  }),
);

const unowned = $derived(paths.length - new Set(ownership.groups.flatMap((g) => g.files)).size);
const open = new SvelteSet<string>();

function toggle(owner: string): void {
  if (open.has(owner)) open.delete(owner);
  else open.add(owner);
}

/** A request is open: the user still requested, or the team not yet answered for. */
function awaiting(row: OwnerRow): boolean {
  return row.reviewer?.kind === "team" || (row.reviewer?.kind === "user" && row.reviewer.requested);
}

function stateLabel(row: OwnerRow): string {
  const by = (logins: readonly string[]) =>
    row.team && logins.length > 0 ? ` by @${logins.join(", @")}` : "";
  switch (row.status) {
    case "approved":
      return `Approved${by(row.approvedBy)}`;
    case "changes_requested":
      return `Requested changes${by(row.changesRequestedBy)}`;
    case "pending":
      return awaiting(row) ? "Awaiting review" : "Not requested";
  }
}
</script>

{#if conversation.codeowners && paths.length > 0 && (rows.length > 0 || unowned > 0)}
	{@const codeowners = conversation.codeowners}
	<SidebarSection id="side-codeowners" title="Code owners" align="baseline">
		{#snippet aside()}
			<span class="co-source" title="Read from {codeowners.path} on {codeowners.ref}">{codeowners.path}</span>
		{/snippet}
		<ul class="co-list">
			{#each rows as row (row.owner)}
				{@const expanded = open.has(row.owner)}
				<li>
					<button
						type="button"
						class="co-row"
						aria-expanded={expanded}
						title={row.owner}
						onclick={() => toggle(row.owner)}
					>
						<span class="co-caret"><DisclosureCaret open={expanded} size={9} /></span>
						{#if row.team}
							<span class="co-team" aria-hidden="true"><UsersThree size={12} /></span>
						{:else}
							<Avatar name={row.name} src={row.avatarContent} size={18} />
						{/if}
						<span class="co-name">{row.name}</span>
						{#if row.mine}
							<span class="co-you" title="You or one of your teams">you</span>
						{/if}
						<span class="co-count">{row.files.length} {row.files.length === 1 ? 'file' : 'files'}</span>
						<span class="co-state" title={stateLabel(row)}>
							{#if row.status !== 'pending'}
								<VerdictGlyph verdict={row.status} size={13} />
							{:else if awaiting(row)}
								<CircleDashed size={13} weight="bold" class="co-awaiting" />
							{/if}
						</span>
					</button>
					{#if expanded}
						<ul class="co-files" transition:gsapSlide>
							{#each row.files as path (path)}
								<li>
									<button
										type="button"
										class="co-file"
										title="Open {path} in the diff"
										onclick={() => openInDiff(prId, path)}
									>
										{path}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
		{#if unowned > 0}
			<p class="co-note">{unowned} {unowned === 1 ? 'file has' : 'files have'} no code owner</p>
		{/if}
	</SidebarSection>
{/if}

<style>
	.co-source {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: var(--text-ui);
		color: var(--color-text-muted);
	}

	.co-list,
	.co-files {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.co-row {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		min-height: 28px;
		padding: 0 4px;
		border: none;
		border-radius: 6px;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.co-row:hover {
		background: var(--color-tree-hover-bg);
	}

	.co-caret {
		display: inline-flex;
		color: var(--color-text-muted);
	}

	.co-team {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		border-radius: 5px;
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.co-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.co-you {
		flex-shrink: 0;
		padding: 0 5px;
		border: 1px solid var(--color-accent-chip-border);
		border-radius: 999px;
		background: var(--color-accent-chip-bg);
		color: var(--color-accent-chip-fg);
		font-size: 0.625rem;
		line-height: 14px;
	}

	.co-count {
		flex-shrink: 0;
		font-size: var(--text-ui);
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.co-state {
		display: inline-flex;
		justify-content: center;
		width: 16px;
		flex-shrink: 0;
	}

	.co-state :global(.co-awaiting) {
		color: var(--color-warning);
	}

	.co-files {
		padding: 2px 0 6px 34px;
	}

	.co-file {
		display: block;
		width: 100%;
		padding: 2px 0;
		border: none;
		background: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
		font-family: var(--font-mono);
		font-size: var(--text-ui);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.co-file:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}

	.co-note {
		margin: 6px 0 0;
		font-size: var(--text-ui);
		color: var(--color-text-muted);
	}
</style>
