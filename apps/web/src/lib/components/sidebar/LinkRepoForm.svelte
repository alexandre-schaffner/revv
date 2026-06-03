<script lang="ts">
import type { Repository } from "@revv/shared";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FolderOpen from "phosphor-svelte/lib/FolderOpen";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import Plus from "phosphor-svelte/lib/Plus";
import Spinner from "phosphor-svelte/lib/Spinner";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import CloneStatusIndicator from "$lib/components/shared/CloneStatusIndicator.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapFadeY, tokens } from "$lib/motion";
import { addRepo, getRepositories, retryClone } from "$lib/stores/prs.svelte";
import { isTauri } from "$lib/utils/platform";
import RepoField from "./RepoField.svelte";

let { onClose }: { onClose?: () => void } = $props();

const runningInTauri = isTauri();

let clonePath = $state("");
// Resolved by the server (`inspect-local`) from the clone's `origin` remote —
// never typed by the user. The remote is the single source of truth for the
// GitHub identity, so a local checkout can't be linked to the wrong repo.
let fullName = $state<string | null>(null);
let inspecting = $state(false);
let adding = $state(false);
let remotes = $state<{ name: string; url: string }[]>([]);
let isGitRepo = $state<boolean | null>(null);
let linkedFullName = $state<string | null>(null);

let tracked = $derived(new Set(getRepositories().map((repo) => repo.fullName.toLowerCase())));
let isAlreadyTracked = $derived(fullName !== null && tracked.has(fullName.toLowerCase()));
let canSubmit = $derived(
  clonePath.trim() !== "" &&
    fullName !== null &&
    !isAlreadyTracked &&
    isGitRepo === true &&
    !adding,
);

// Once linked, surface the freshly-tracked repo from the store so its
// clone-status (and any SSE updates) render inline, mirroring the clone path.
let linkedRepo = $derived<Repository | null>(
  linkedFullName ? (getRepositories().find((r) => r.fullName === linkedFullName) ?? null) : null,
);

async function inspectPath(path: string): Promise<void> {
  if (!path.trim()) return;
  inspecting = true;
  try {
    const { data, error } = await api.api.repos["inspect-local"].post({ path });
    if (error) {
      const value = error.value as { error?: string; message?: string } | undefined;
      throw new Error(value?.error ?? value?.message ?? "Failed to inspect local repository");
    }
    if (!data || "error" in data) {
      throw new Error("Failed to inspect local repository");
    }
    isGitRepo = data.isGitRepo;
    remotes = [...data.remotes];
    fullName = data.proposedFullName;
    if (!data.isGitRepo) toast.error("Choose a folder that contains a git repository");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to inspect local repository");
  } finally {
    inspecting = false;
  }
}

async function browse(): Promise<void> {
  if (!runningInTauri || inspecting) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    if (typeof selected !== "string") return;
    clonePath = selected;
    await inspectPath(selected);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to open folder picker");
  }
}

async function submit(): Promise<void> {
  if (!canSubmit || fullName === null) return;
  adding = true;
  try {
    await addRepo({ fullName, mode: "link", clonePath: clonePath.trim() });
    linkedFullName = fullName;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to link repository");
  } finally {
    adding = false;
  }
}

function linkAnother(): void {
  linkedFullName = null;
  clonePath = "";
  fullName = null;
  remotes = [];
  isGitRepo = null;
}

function onPathKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") onClose?.();
  else if (e.key === "Enter") {
    if (canSubmit) void submit();
    else void inspectPath(clonePath);
  }
}
</script>

<div class="link-form">
	{#if linkedRepo}
		<div class="success-view" in:gsapFadeY={{ y: 6, duration: tokens.quick }}>
			<div class="form-header">
				<h2 class="title">Repository Linked</h2>
			</div>

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
					<span class="linked-path">{linkedRepo.clonePath ?? clonePath}</span>
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
							<LinkSimple size={10} weight="bold" />
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
		<div class="form-header">
			<h2 class="title">Open Existing Clone</h2>
			<span class="title-meta">Linked</span>
		</div>

		<div class="path-row">
			<RepoField
				placeholder="/Users/alex/code/project"
				aria-label="Local clone path"
				bind:value={clonePath}
				onblur={() => void inspectPath(clonePath)}
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
				onclick={() => void browse()}
				disabled={!runningInTauri || inspecting}
			>
				{#if inspecting}
					<Spinner size={13} weight="bold" class="motion-essential-spin" />
				{:else}
					<FolderOpen size={13} weight="fill" />
				{/if}
				<span>Browse</span>
			</Button>
		</div>

		{#if isGitRepo === false}
			<p class="hint hint--danger">The selected folder is not a git repository.</p>
		{:else if isAlreadyTracked && !adding}
			<p class="hint hint--danger">This repository is already tracked.</p>
		{:else if isGitRepo === true && fullName !== null}
			<p class="hint hint--ok">
				<CheckCircle size={12} weight="fill" />
				<span>Recognized as <code>{fullName}</code>.</span>
			</p>
		{:else if isGitRepo === true}
			<p class="hint hint--danger">
				This clone's <code>origin</code> remote doesn't point at a repository on this GitHub host.
			</p>
		{:else if remotes.length > 0}
			<div class="remote-list">
				{#each remotes.slice(0, 3) as remote (`${remote.name}-${remote.url}`)}
					<div class="remote-row">
						<span>{remote.name}</span>
						<code>{remote.url}</code>
					</div>
				{/each}
			</div>
		{:else}
			<p class="hint">Choose a local checkout — its GitHub repository is detected automatically.</p>
		{/if}

		<div class="footer">
			<Button variant="default" size="sm" class="link-btn" onclick={() => void submit()} disabled={!canSubmit}>
				{#if adding}
					<Spinner size={12} weight="bold" class="motion-essential-spin" />
				{:else}
					<Plus size={12} weight="bold" />
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

	.form-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
		flex-shrink: 0;
	}

	.title {
		margin: 0;
		color: var(--color-text-primary);
		font-size: 13.5px;
		font-weight: 600;
		letter-spacing: -0.005em;
	}

	.title-meta {
		color: var(--color-text-muted);
		font-size: 11px;
	}

	.path-row {
		display: flex;
		gap: 6px;
	}

	.path-row :global(.affordance-btn) {
		flex-shrink: 0;
	}

	/* ── Hints ──────────────────────────────────────────── */
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

	.remote-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 10px;
	}

	.remote-row {
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr);
		gap: 8px;
		align-items: center;
		color: var(--color-text-muted);
		font-size: 11px;
	}

	.remote-row code {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-secondary);
	}

	/* ── Success view ───────────────────────────────────── */
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

	/* ── Footer ─────────────────────────────────────────── */
	.footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin: 14px -20px 0;
		padding: 10px 20px 0;
		border-top: 1px solid var(--color-border-subtle);
	}
</style>
