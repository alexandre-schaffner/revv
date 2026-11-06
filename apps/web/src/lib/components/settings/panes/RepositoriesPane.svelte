<script module lang="ts">
import FolderSimple from "phosphor-svelte/lib/FolderSimple";
import { defineSettingsPane } from "../settings-panes";

export const pane = defineSettingsPane({
  id: "repositories",
  title: "Repositories",
  description: "The repositories whose pull requests Revv syncs.",
  icon: FolderSimple,
  rows: {
    list: {
      label: "Tracked repositories",
      keywords: ["repos", "remove", "delete", "add", "track"],
    },
  },
});
</script>

<script lang="ts">
import type { Repository } from "@revv/shared";
import Plus from "phosphor-svelte/lib/Plus";
import Spinner from "phosphor-svelte/lib/Spinner";
import Trash from "phosphor-svelte/lib/Trash";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import RepoDeleteConfirm from "$lib/components/sidebar/RepoDeleteConfirm.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { RepoRemoval } from "$lib/repos/repo-removal.svelte";
import { getRepositories } from "$lib/stores/prs.svelte";
import { closeSettings } from "$lib/stores/settingsModal.svelte";
import { openAddRepoDialog } from "$lib/stores/sidebar.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";

const repositories = $derived(getRepositories());

const removal = new RepoRemoval();

// The add-repo dialog lives in the sidebar; hand over to it rather than
// stacking a second modal on this one.
function handleAddRepository(): void {
  closeSettings();
  openAddRepoDialog();
}

function repoHint(repo: Repository): string | undefined {
  const parts: string[] = [];
  if (repo.githubHost !== "github.com") parts.push(repo.githubHost);
  if (!repo.managed && repo.clonePath) parts.push(`Linked to ${repo.clonePath}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
</script>

<SettingsPane {pane}>
	<SettingsGroup heading="Tracked repositories">
		{#snippet actions()}
			<span class="repo-count" aria-label="{repositories.length} repositories">{repositories.length}</span>
			<Button variant="outline" size="sm" onclick={handleAddRepository}>
				<Plus size={12} />
				Add repository
			</Button>
		{/snippet}

		{#if repositories.length === 0}
			<SettingsRow
				row={pane.rows.list}
				label="No repositories yet"
				hint="Add a repository to start syncing its pull requests."
			/>
		{:else}
			{#each repositories as repo, i (repo.id)}
				<SettingsRow
					row={i === 0 ? pane.rows.list : undefined}
					label={repo.fullName}
					hint={repoHint(repo)}
				>
					{#snippet leading()}
						<RepoGradientAvatar fullName={repo.fullName} ownerAvatarUrl={repo.avatarUrl} size={22} radius={6} />
					{/snippet}
					{#snippet control()}
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={removal.isRemoving(repo.id)}
							onclick={() => removal.request(repo)}
							aria-label="Remove {repo.fullName}"
							title="Remove repository"
						>
							{#if removal.isRemoving(repo.id)}
								<Spinner size={13} class="motion-essential-spin" />
							{:else}
								<Trash size={13} />
							{/if}
						</Button>
					{/snippet}
				</SettingsRow>
			{/each}
		{/if}
	</SettingsGroup>
</SettingsPane>

<RepoDeleteConfirm
	repo={removal.pending}
	open={removal.pending !== null}
	deleting={removal.deleting}
	onOpenChange={removal.onOpenChange}
	onConfirm={() => void removal.confirm()}
/>

<style>
	.repo-count {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11px;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}
</style>
