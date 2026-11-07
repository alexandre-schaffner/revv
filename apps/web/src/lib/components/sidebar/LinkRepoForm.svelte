<script lang="ts">
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FolderOpen from "phosphor-svelte/lib/FolderOpen";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import Plus from "phosphor-svelte/lib/Plus";
import Spinner from "phosphor-svelte/lib/Spinner";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapFadeY, tokens } from "$lib/motion";
import { getTrackedRepo, LocalClone } from "$lib/repos/add-repo.svelte";
import { toastAddRepoError } from "$lib/repos/add-repo-toast";
import { addRepo, retryClone } from "$lib/stores/repos.svelte";
import CloneStatusIndicator from "./CloneStatusIndicator.svelte";
import RepoDialogHeader from "./RepoDialogHeader.svelte";
import RepoField from "./RepoField.svelte";

let { onClose }: { onClose?: () => void } = $props();

const clone = new LocalClone();
let adding = $state(false);
let linkedFullName = $state<string | null>(null);

let canSubmit = $derived(clone.linkableName !== null && !adding);

let linkedRepo = $derived(linkedFullName ? (getTrackedRepo(linkedFullName) ?? null) : null);

async function submit(): Promise<void> {
  const fullName = clone.linkableName;
  if (adding || fullName === null) return;
  adding = true;
  try {
    await addRepo({ fullName, mode: "link", clonePath: clone.path.trim() });
    linkedFullName = fullName;
  } catch (e) {
    toastAddRepoError(e, "Failed to link repository");
  } finally {
    adding = false;
  }
}

function linkAnother(): void {
  linkedFullName = null;
  clone.clear();
}

function onPathKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") onClose?.();
  else if (e.key === "Enter") {
    if (canSubmit) void submit();
    else void clone.inspect();
  }
}
</script>

<div class="link-form">
	{#if linkedRepo}
		<div class="success-view" in:gsapFadeY={{ y: 6, duration: tokens.quick }}>
			<RepoDialogHeader title="Repository Linked" />

			<div class="linked-card">
				<RepoGradientAvatar
					fullName={linkedRepo.fullName}
					ownerAvatarUrl={linkedRepo.avatarUrl}
					size={26}
					radius={999}
					class="linked-avatar"
				/>
				<div class="linked-body">
					<span class="linked-name">{linkedRepo.fullName}</span>
					<span class="linked-path">{linkedRepo.clonePath ?? clone.path}</span>
				</div>
				<div class="linked-status">
					{#if linkedRepo.cloneStatus !== 'ready'}
						<CloneStatusIndicator
							status={linkedRepo.cloneStatus}
							error={linkedRepo.cloneError}
							onRetry={() => retryClone(linkedRepo.id)}
							size={13}
							showLabel
						/>
					{:else}
						<span class="linked-pill" title="Linked clone">
							<LinkSimple size={10} />
							Linked
						</span>
					{/if}
				</div>
			</div>

			<div class="footer">
				<Button variant="ghost" size="sm" onclick={linkAnother}>Link Another</Button>
				<Button variant="default" size="sm" onclick={() => onClose?.()}>Done</Button>
			</div>
		</div>
	{:else}
		<RepoDialogHeader title="Open Existing Clone" meta="Linked" />

		<div class="path-row">
			<RepoField
				placeholder="/Users/you/code/project"
				aria-label="Local clone path"
				bind:value={clone.path}
				onblur={() => void clone.inspect()}
				onkeydown={onPathKeydown}
				autofocusOnMount
				autocomplete="off"
				spellcheck="false"
			>
				{#snippet icon()}<FolderOpen size={13} />{/snippet}
			</RepoField>
			<Button
				variant="outline"
				size="sm"
				class="affordance-btn h-8 rounded-[var(--radius-card)]"
				onclick={() => void clone.browse()}
				disabled={clone.inspecting}
			>
				{#if clone.inspecting}
					<Spinner size={13} class="motion-essential-spin" />
				{:else}
					<FolderOpen size={13} />
				{/if}
				<span>Browse</span>
			</Button>
		</div>

		{#if clone.status.kind === "not-git"}
			<p class="hint hint--danger">The selected folder is not a git repository.</p>
		{:else if clone.status.kind === "tracked" && !adding}
			<p class="hint hint--danger">This repository is already tracked.</p>
		{:else if clone.status.kind === "recognized" || clone.status.kind === "tracked"}
			<p class="hint hint--ok">
				<CheckCircle size={12} />
				<span>Recognized as <code>{clone.status.fullName}</code>.</span>
			</p>
		{:else if clone.status.kind === "foreign-origin"}
			<p class="hint hint--danger">
				This clone's <code>origin</code> remote doesn't point at a repository on this GitHub host.
			</p>
		{:else}
			<p class="hint">Choose a local checkout — its GitHub repository is detected automatically.</p>
		{/if}

		<div class="footer">
			<Button variant="default" size="sm" class="link-btn" onclick={() => void submit()} disabled={!canSubmit}>
				{#if adding}
					<Spinner size={12} class="motion-essential-spin" />
				{:else}
					<Plus size={12} />
				{/if}
				<span>Link Repository</span>
			</Button>
		</div>
	{/if}
</div>

<style>
	.link-form,
	.success-view {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}

	.path-row {
		display: flex;
		gap: 6px;
	}

	.path-row :global(.affordance-btn) {
		flex-shrink: 0;
	}

	.hint {
		display: flex;
		align-items: center;
		gap: 5px;
		margin: 8px 2px 0;
		color: var(--color-text-muted);
		font-size: 11px;
		line-height: 1.4;
	}

	.hint :global(svg) {
		flex-shrink: 0;
	}

	.hint code {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		color: var(--color-text-secondary);
	}

	.hint--danger {
		color: var(--color-danger);
	}

	.hint--ok {
		color: var(--color-success);
	}

	.hint--ok code {
		color: var(--color-success);
	}

	.linked-card {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 13px;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
		background: var(--color-glass-bg);
	}

	:global(.linked-avatar) {
		flex-shrink: 0;
	}

	.linked-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.linked-name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.linked-path {
		font-size: 11px;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
	}

	.linked-status {
		flex-shrink: 0;
	}

	.linked-pill {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		height: 18px;
		padding: 0 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-text-secondary);
		font-size: 10.5px;
	}

	.footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin: 14px -20px 0;
		padding: 10px 20px 0;
		border-top: 1px solid var(--color-border-subtle);
	}
</style>
