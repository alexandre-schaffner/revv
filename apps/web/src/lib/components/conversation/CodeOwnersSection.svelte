<script lang="ts">
import { type CodeownersFile, codeownersFor, type ReviewerEntry } from "@revv/shared";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { gsapSlide } from "$lib/motion";
import { getReviewFiles, openFileInDiff } from "$lib/stores/review.svelte";
import VerdictGlyph, { VERDICT_LABEL } from "./VerdictGlyph.svelte";

// Who CODEOWNERS makes responsible for this PR's files, read from the base
// branch's CODEOWNERS and matched against the changed files. Each owner
// carries their review state when they're among the reviewers.

interface Props {
  codeowners: CodeownersFile;
  reviewers: readonly ReviewerEntry[];
  /** The conversation's avatars by login, for owners who aren't reviewers. */
  avatars: Readonly<Record<string, string>>;
}

let { codeowners, reviewers, avatars }: Props = $props();

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
  readonly avatarContent: string | null;
}

const paths = $derived(getReviewFiles().map((f) => f.path));
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
            : !team && r.actor.login.toLowerCase() === handle.toLowerCase(),
        ) ?? null;
      return {
        owner,
        team,
        name: reviewer?.kind === "team" ? reviewer.name : handle,
        files: owned.sort(),
        reviewer,
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
  const r = row.reviewer;
  if (!r) return "Not requested";
  if (r.kind === "user" && r.verdict) return VERDICT_LABEL[r.verdict];
  return "Awaiting review";
}
</script>

{#if paths.length > 0 && (rows.length > 0 || unowned > 0)}
	<section aria-labelledby="side-codeowners">
		<header class="co-head">
			<h3 id="side-codeowners">Code owners</h3>
			<span class="co-source" title="Read from {codeowners.path} on {codeowners.ref}">{codeowners.path}</span>
		</header>
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
						<span class="co-caret" class:co-caret--open={expanded} aria-hidden="true">
							<CaretRight size={9} weight="bold" />
						</span>
						{#if row.team}
							<span class="co-team" aria-hidden="true"><UsersThree size={12} /></span>
						{:else}
							<Avatar handle={row.name} avatarContent={row.avatarContent} size={18} />
						{/if}
						<span class="co-name">{row.name}</span>
						<span class="co-count">{row.files.length} {row.files.length === 1 ? 'file' : 'files'}</span>
						<span class="co-state" title={stateLabel(row)}>
							{#if row.reviewer?.kind === 'user' && row.reviewer.verdict}
								<VerdictGlyph verdict={row.reviewer.verdict} size={13} />
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
	</section>
{/if}

<style>
	.co-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		min-height: 24px;
		margin-bottom: 6px;
	}

	.co-head h3 {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

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
		transition: rotate var(--duration-snap) var(--ease-soft);
	}

	.co-caret--open {
		rotate: 90deg;
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
