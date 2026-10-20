<script lang="ts">
/*
 * The second step before "Rebase stack". The rebase force-pushes every open
 * layer's branch, often branches other people own, so it never fires on one
 * click: this names each branch it will rewrite, and whose it is when it
 * isn't the viewer's, and the push happens from here.
 */
import { isOpenLayer, loginsMatch, type PrStackDetail } from "@revv/shared";
import { AlertDialog } from "bits-ui";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
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
/** What gets force-pushed, top of the stack first like the stack list. */
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
					<div class="confirm-header">
						<span class="confirm-icon" aria-hidden="true">
							<ArrowsClockwise size={16} />
						</span>
						<AlertDialog.Title>
							{#snippet child({ props: titleProps })}
								<h2 {...titleProps} class="confirm-title">Rebase stack #{stack.number}?</h2>
							{/snippet}
						</AlertDialog.Title>
					</div>

					<AlertDialog.Description>
						{#snippet child({ props: descProps })}
							<p {...descProps} class="confirm-description">
								Revv replays each open layer onto the one below it, the bottom onto
								<code>{stack.baseRefName}</code>, and force-pushes {pushed.length === 1
									? 'its branch'
									: `these ${pushed.length} branches`} together. Nothing is pushed if a layer
								conflicts or moved meanwhile.
							</p>
						{/snippet}
					</AlertDialog.Description>

					<ul class="confirm-branches">
						{#each pushed as layer (layer.number)}
							<li>
								<code class="branch">{layer.headRef}</code>
								<span class="owner">
									#{layer.number}{#if layer.authorLogin && !loginsMatch(layer.authorLogin, viewer)}
										· {layer.authorLogin}'s{/if}
								</span>
							</li>
						{/each}
					</ul>

					{#if othersOwn}
						<p class="confirm-note">
							Anyone with these branches checked out will need to reset onto the new heads.
						</p>
					{/if}

					<div class="confirm-actions">
						<AlertDialog.Cancel class={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							class={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'confirm-push')}
							onclick={onConfirm}
						>
							<ArrowsClockwise size={13} />
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
		width: min(440px, calc(100vw - 32px));
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
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 22%, transparent);
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

	.confirm-description,
	.confirm-note {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}

	.confirm-note {
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.confirm-description code {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}

	.confirm-branches {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 180px;
		margin: 0;
		padding: 7px 10px;
		overflow-y: auto;
		list-style: none;
		border: 1px solid var(--color-border-subtle);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
	}

	.confirm-branches li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
		line-height: 1.5;
	}

	.branch {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--color-text-primary);
	}

	.owner {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}

	.confirm-content :global(.confirm-push) {
		gap: 6px;
	}
</style>
