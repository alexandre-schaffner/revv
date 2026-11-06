<script lang="ts">
import {
  type CodeownersFile,
  codeownersFor,
  loginsMatch,
  type ReviewerEntry,
  type ReviewVerdict,
  reviewerVerdict,
} from "@revv/shared";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/shared/Avatar.svelte";
import DisclosureCaret from "$lib/components/shared/DisclosureCaret.svelte";
import { VERDICT_LABEL } from "$lib/conversation/verdict";
import { gsapSlide } from "$lib/motion";
import { getChangedPaths } from "$lib/stores/diff-files.svelte";
import { openFileInDiff } from "$lib/stores/review-nav.svelte";
import SidebarSection from "./SidebarSection.svelte";
import VerdictGlyph from "./VerdictGlyph.svelte";

// Who CODEOWNERS makes responsible for this PR's files, read from the base
// branch's CODEOWNERS and matched against the changed files. Each owner
// carries their review state when they're among the reviewers.

interface Props {
  prId: string;
  codeowners: CodeownersFile;
  reviewers: readonly ReviewerEntry[];
  /** The conversation's avatars by login, for owners who aren't reviewers. */
  avatars: Readonly<Record<string, string>>;
}

let { prId, codeowners, reviewers, avatars }: Props = $props();

/** CODEOWNERS handles needn't match a login's case. */
const avatarsByHandle = $derived(
  new Map(Object.entries(avatars).map(([login, content]) => [login.toLowerCase(), content])),
);

interface OwnerRow {
  readonly owner: string;
  readonly team: boolean;
  readonly name: string;
  readonly files: readonly string[];
  readonly reviewer: ReviewerEntry | null;
  readonly verdict: ReviewVerdict | null;
  readonly avatarContent: string | null;
}

const paths = $derived(getChangedPaths(prId));
const ownersByPath = $derived(codeownersFor(codeowners.rules, paths));

const rows = $derived.by((): OwnerRow[] => {
  const files = new Map<string, string[]>();
  for (const [path, owners] of ownersByPath) {
    for (const owner of owners) files.set(owner, [...(files.get(owner) ?? []), path]);
  }
  return [...files]
    .map(([owner, owned]): OwnerRow => {
      const handle = owner.replace(/^@/, "");
      const team = handle.includes("/");
      const reviewer =
        reviewers.find((r) =>
          r.kind === "team"
            ? team && r.combinedSlug.toLowerCase() === handle.toLowerCase()
            : !team && loginsMatch(r.actor.login, handle),
        ) ?? null;
      return {
        owner,
        team,
        name: reviewer?.kind === "team" ? reviewer.name : handle,
        files: owned.sort(),
        reviewer,
        verdict: reviewer ? reviewerVerdict(reviewer) : null,
        avatarContent:
          (reviewer?.kind === "user" ? reviewer.actor.avatarContent : null) ??
          avatarsByHandle.get(handle.toLowerCase()) ??
          null,
      };
    })
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
});

const unowned = $derived([...ownersByPath.values()].filter((owners) => owners.length === 0).length);
const open = new SvelteSet<string>();

function toggle(owner: string): void {
  if (open.has(owner)) open.delete(owner);
  else open.add(owner);
}

function stateLabel(row: OwnerRow): string {
  if (!row.reviewer) return "Not requested";
  return row.verdict ? VERDICT_LABEL[row.verdict] : "Awaiting review";
}
</script>

{#if paths.length > 0 && (rows.length > 0 || unowned > 0)}
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
						<span class="co-count">{row.files.length} {row.files.length === 1 ? 'file' : 'files'}</span>
						<span class="co-state" title={stateLabel(row)}>
							{#if row.verdict}
								<VerdictGlyph verdict={row.verdict} size={13} />
							{:else if row.reviewer}
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
										onclick={() => openFileInDiff(path)}
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
		font-size: 0.6875rem;
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
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.co-count {
		flex-shrink: 0;
		font-size: 0.75rem;
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
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.co-file:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}

	.co-note {
		margin: 6px 0 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}
</style>
