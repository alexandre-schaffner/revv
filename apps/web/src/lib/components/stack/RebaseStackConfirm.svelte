<script lang="ts">
import { isOpenLayer, loginsMatch, type PrStackDetail } from "@revv/shared";
import { AlertDialog } from "bits-ui";
import { buttonVariants } from "$lib/components/ui/button/index.js";
import { bitsAnim, dialogSpringIn, dialogSpringOut } from "$lib/motion";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { plural } from "$lib/utils/plural";
import { cn } from "$lib/utils.js";

interface Props {
  open: boolean;
  stack: PrStackDetail;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

let { open, stack, onOpenChange, onConfirm }: Props = $props();

const viewer = $derived(getCurrentUserLogin());
const pushed = $derived(stack.layers.filter(isOpenLayer).reverse());
const othersOwn = $derived(
  pushed.some((l) => l.authorLogin !== null && !loginsMatch(l.authorLogin, viewer)),
);
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
					<AlertDialog.Title>
						{#snippet child({ props: titleProps })}
							<h2 {...titleProps} class="confirm-title">Rebase stack #{stack.number}</h2>
						{/snippet}
					</AlertDialog.Title>

					<AlertDialog.Description>
						{#snippet child({ props: descProps })}
							<p {...descProps} class="confirm-description">
								Replay each open layer onto the one below it, starting from
								<code>{stack.baseRefName}</code>, then force-push {plural(pushed.length, 'branch', 'branches')}.
							</p>
						{/snippet}
					</AlertDialog.Description>

					<ul class="confirm-branches" aria-label="Branches to force-push">
						{#each pushed as layer (layer.number)}
							<li>
								<span class="pr-number">#{layer.number}</span>
								<div class="branch-info">
									<code class="branch">{layer.headRef}</code>
									{#if layer.authorLogin && !loginsMatch(layer.authorLogin, viewer)}
										<span class="owner">{layer.authorLogin}</span>
									{/if}
								</div>
							</li>
						{/each}
					</ul>

					<p class="confirm-note">Nothing is pushed if a layer conflicts or has changed.</p>

					{#if othersOwn}
						<p class="confirm-note">
							Anyone with these branches checked out will need to reset onto the new heads.
						</p>
					{/if}

					<div class="confirm-actions">
						<AlertDialog.Cancel class={cn(buttonVariants({ variant: 'ghost', size: 'default' }))}>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							class={cn(buttonVariants({ variant: 'default', size: 'default' }))}
							onclick={onConfirm}
						>
							Force-push {plural(pushed.length, 'branch', 'branches')}
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
	}

	.confirm-content {
		position: fixed;
		top: min(20vh, 160px);
		inset-inline: 0;
		z-index: 61;
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: min(520px, calc(100vw - 32px));
		max-height: calc(100dvh - min(20vh, 160px) - 16px);
		margin-inline: auto;
		padding: 24px;
		overflow-y: auto;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
		outline: none;
	}

	.confirm-title {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.4;
	}

	.confirm-description,
	.confirm-note {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.confirm-description code {
		font-family: var(--font-mono);
		font-size: inherit;
		color: var(--color-text-primary);
	}

	.confirm-branches {
		flex-shrink: 0;
		max-height: 240px;
		margin: 4px 0;
		padding: 4px 0;
		overflow-y: auto;
		list-style: none;
		border-block: 1px solid var(--color-border-subtle);
	}

	.confirm-branches li {
		display: flex;
		align-items: baseline;
		gap: 16px;
		padding-block: 8px;
		font-size: 13px;
		line-height: 1.5;
	}

	.pr-number {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-subtle);
	}

	.branch-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.branch {
		font-family: var(--font-mono);
		font-size: inherit;
		overflow-wrap: anywhere;
	}

	.owner {
		color: var(--color-text-secondary);
	}

	.confirm-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 8px;
	}
</style>
