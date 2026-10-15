<script lang="ts">
import type { Repository } from "@revv/shared";
import Plus from "phosphor-svelte/lib/Plus";
import Spinner from "phosphor-svelte/lib/Spinner";
import Trash from "phosphor-svelte/lib/Trash";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import RepoDeleteConfirm from "$lib/components/sidebar/RepoDeleteConfirm.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { deleteRepo, getRepositories } from "$lib/stores/prs.svelte";
import { closeSettings } from "$lib/stores/settingsModal.svelte";
import { openAddRepoDialog } from "$lib/stores/sidebar.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import { SETTINGS_PANES } from "../settings-index";

const repositories = $derived(getRepositories());

let removingRepoId = $state<string | null>(null);
let repoPendingDelete = $state<Repository | null>(null);

async function handleDeleteRepo(id: string): Promise<void> {
  removingRepoId = id;
  try {
    await deleteRepo(id);
    repoPendingDelete = null;
  } catch {
    // The store restores optimistic state and shows the failure toast.
  } finally {
    removingRepoId = null;
  }
}

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

<SettingsPane {...SETTINGS_PANES.repositories}>
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
				id="repositories-list"
				label="No repositories yet"
				hint="Add a repository to start syncing its pull requests."
			/>
		{:else}
			{#each repositories as repo (repo.id)}
				<SettingsRow id="repo-{repo.id}" label={repo.fullName} hint={repoHint(repo)}>
					{#snippet leading()}
						<RepoGradientAvatar fullName={repo.fullName} ownerAvatarUrl={repo.avatarUrl} size={22} radius={6} />
					{/snippet}
					{#snippet control()}
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={removingRepoId === repo.id}
							onclick={() => (repoPendingDelete = repo)}
							aria-label="Remove {repo.fullName}"
							title="Remove repository"
						>
							{#if removingRepoId === repo.id}
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
	repo={repoPendingDelete}
	open={repoPendingDelete !== null}
	deleting={repoPendingDelete ? removingRepoId === repoPendingDelete.id : false}
	onOpenChange={(nextOpen) => {
		if (!nextOpen && (!repoPendingDelete || removingRepoId !== repoPendingDelete.id)) {
			repoPendingDelete = null;
		}
	}}
	onConfirm={() => {
		if (repoPendingDelete) void handleDeleteRepo(repoPendingDelete.id);
	}}
/>

<style>
	.repo-count {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11px;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}
</style>
