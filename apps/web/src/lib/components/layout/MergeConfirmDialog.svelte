<script lang="ts">
/*
 * The second step before a reviewer merges someone else's pull request. The
 * merge pill sits beside Approve, so it never fires on one click: this names
 * the PR, its author, and where it lands, and the merge happens from here.
 */
import { AlertDialog } from "bits-ui";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import { buttonVariants } from "$lib/components/ui/button/index.js";
import { bitsAnim, dialogSpringIn, dialogSpringOut } from "$lib/motion";
import { cn } from "$lib/utils.js";

interface Props {
  open: boolean;
  prNumber: number;
  authorLogin: string;
  targetBranch: string;
  /** The strategy's menu label, e.g. "Squash and merge". */
  methodLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

let { open, prNumber, authorLogin, targetBranch, methodLabel, onOpenChange, onConfirm }: Props =
  $props();
</script>

<AlertDialog.Root {open} {onOpenChange}>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="confirm-overlay" />
		<AlertDialog.Content>
			{#snippet child({ props })}
				<div
					{...props}
					class="confirm-content"
					use:bitsAnim={{ inPreset: dialogSpringIn, outPreset: dialogSpringOut }}
				>
					<div class="confirm-header">
						<span class="confirm-icon" aria-hidden="true">
							<GitMerge size={16} />
						</span>
						<AlertDialog.Title>
							{#snippet child({ props: titleProps })}
								<h2 {...titleProps} class="confirm-title">Merge #{prNumber}?</h2>
							{/snippet}
						</AlertDialog.Title>
					</div>

					<AlertDialog.Description>
						{#snippet child({ props: descProps })}
							<p {...descProps} class="confirm-description">
								This merges {authorLogin}'s pull request into <code>{targetBranch}</code>
								({methodLabel.toLowerCase()}). It can't be undone from Revv.
							</p>
						{/snippet}
					</AlertDialog.Description>

					<div class="confirm-actions">
						<AlertDialog.Cancel class={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							class={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'confirm-merge')}
							onclick={onConfirm}
						>
							<GitMerge size={13} />
							{methodLabel}
						</AlertDialog.Action>
					</div>
				</div>
			{/snippet}
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>

<style>
	.confirm-overlay {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.confirm-content {
		position: fixed;
		top: 24%;
		left: 0;
		right: 0;
		z-index: 61;
		display: flex;
		width: min(408px, calc(100vw - 32px));
		margin: 0 auto;
		flex-direction: column;
		gap: 10px;
		border: 1px solid var(--color-glass-border);
		border-radius: 12px;
		background: var(--color-glass-bg);
		padding: 20px;
		color: var(--color-text-primary);
		backdrop-filter: blur(20px) saturate(1.4);
		-webkit-backdrop-filter: blur(20px) saturate(1.4);
		box-shadow:
			var(--color-shadow-xl),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		outline: none;
	}

	.confirm-header {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.confirm-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-success) 22%, transparent);
	}

	.confirm-title {
		margin: 0;
		min-width: 0;
		color: var(--color-text-primary);
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		letter-spacing: -0.01em;
	}

	.confirm-description {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}

	.confirm-description code {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}

	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}

	.confirm-content :global(.confirm-merge) {
		gap: 6px;
	}
</style>
