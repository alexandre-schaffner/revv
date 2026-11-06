<script lang="ts">
// Split button in the chat header: push the agent's commits to the PR branch,
// or (chevron) to a new branch.
import CaretDown from "phosphor-svelte/lib/CaretDown";
import GitBranch from "phosphor-svelte/lib/GitBranch";
import Spinner from "phosphor-svelte/lib/Spinner";
import UploadSimple from "phosphor-svelte/lib/UploadSimple";
import { isPushingProposed, pushProposed } from "$lib/chat/proposed.svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import NewBranchDialog from "./NewBranchDialog.svelte";

interface Props {
  prId: string;
  commitCount: number;
  sourceBranch: string | undefined;
  /** Another chat operation holds the worktree. */
  blocked: boolean;
  onConflict: (conflict: { files: readonly string[]; branch: string }) => void;
}

let { prId, commitCount, sourceBranch, blocked, onConflict }: Props = $props();

let pillEl: HTMLDivElement;
let menuOpen = $state(false);
let newBranchDialog: NewBranchDialog;

const isPushing = $derived(isPushingProposed(prId));
const disabled = $derived(isPushing || blocked);
const commits = $derived(`${commitCount} commit${commitCount === 1 ? "" : "s"}`);

function pulse(): void {
  if (prefersReducedMotion()) return;
  gsap
    .timeline()
    .to(pillEl, { scale: 1.04, duration: tokens.smooth / 2, ease: tokens.easeOutExpo })
    .to(pillEl, { scale: 1, duration: tokens.smooth / 2, ease: tokens.easeOutExpo });
}

async function push(): Promise<void> {
  if (disabled) return;
  const result = await pushProposed(prId);
  if (result?.status === "pushed") pulse();
  else if (result?.status === "conflict")
    onConflict({ files: result.files, branch: result.branch });
}
</script>

<div class="push-pill" bind:this={pillEl}>
	<button
		type="button"
		class="push-pill-main"
		onclick={push}
		title={`Push ${commits}${sourceBranch ? ` to ${sourceBranch}` : ""}`}
		aria-label={`Push ${commits} to PR branch`}
		{disabled}
	>
		{#if isPushing}
			<Spinner size={12} class="motion-essential-spin" />
			<span class="push-pill-label">Pushing…</span>
		{:else}
			<UploadSimple size={12} />
			<span class="push-pill-label">
				Push
				<span class="push-pill-count">{commitCount}</span>
			</span>
		{/if}
	</button>
	<PopoverRoot bind:open={menuOpen}>
		<PopoverTrigger>
			<button
				type="button"
				class="push-pill-chevron"
				aria-label="Push options"
				title="Push options"
				{disabled}
			>
				<CaretDown size={11} />
			</button>
		</PopoverTrigger>
		<PopoverContent class="w-72 p-1" align="end" side="bottom">
			<button
				type="button"
				class="push-menu-item"
				onclick={() => {
					menuOpen = false;
					newBranchDialog.show();
				}}
			>
				<GitBranch size={12} class="push-menu-item-icon" />
				<div class="push-menu-item-body">
					<span class="push-menu-item-title">Push to new branch…</span>
					<span class="push-menu-item-hint">
						Don't change the PR. Push the agent's commits to a new ref.
					</span>
				</div>
			</button>
		</PopoverContent>
	</PopoverRoot>
</div>

<NewBranchDialog bind:this={newBranchDialog} {prId} {commitCount} {sourceBranch} onPushed={pulse} />

<style>
	/* Two halves joined by a hairline: the wide half pushes to the PR branch,
	   the chevron opens the other targets. A neutral chip; the accent shows
	   only in the icon and the count. Hover lives on the wrapper so both
	   halves light up as one surface. */
	.push-pill {
		display: inline-flex;
		align-items: stretch;
		height: 24px;
		border-radius: 6px;
		overflow: hidden;
		background: transparent;
		color: var(--color-text-primary);
		border: 1px solid color-mix(in srgb, var(--color-text-muted) 55%, transparent);
		transition: background-color var(--duration-snap), border-color var(--duration-snap);
	}

	.push-pill:hover:not(:has(button:disabled)) {
		background: var(--color-bg-tertiary);
		border-color: var(--color-text-muted);
	}

	.push-pill-main,
	.push-pill-chevron {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	/* Press feedback on the half actually clicked. */
	.push-pill-main:active:not(:disabled),
	.push-pill-chevron:active:not(:disabled) {
		background: rgba(0, 0, 0, 0.08);
	}

	.push-pill-main {
		gap: 6px;
		padding: 0 9px;
		font-size: 12px;
		font-weight: 500;
		letter-spacing: 0.01em;
	}

	.push-pill-main :global(svg) {
		color: var(--color-accent);
	}

	.push-pill-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		line-height: 1;
		color: var(--color-text-primary);
	}

	.push-pill-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 16px;
		height: 16px;
		padding: 0 5px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-accent) 22%, transparent);
		color: var(--color-accent);
		font-size: 10px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.push-pill-chevron {
		width: 18px;
		padding: 0;
		border-left: 1px solid color-mix(in srgb, var(--color-text-muted) 55%, transparent);
		color: var(--color-text-muted);
	}

	.push-pill-main:disabled,
	.push-pill-chevron:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Inner radius = the popover's (12px) minus its p-1 padding, so the hover
	   fill stays concentric. */
	.push-menu-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		background: transparent;
		border: none;
		border-radius: 8px;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-snap);
	}

	.push-menu-item:hover {
		background: var(--color-bg-tertiary);
	}

	.push-menu-item :global(.push-menu-item-icon) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--color-accent);
	}

	.push-menu-item-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.push-menu-item-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.push-menu-item-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}
</style>
