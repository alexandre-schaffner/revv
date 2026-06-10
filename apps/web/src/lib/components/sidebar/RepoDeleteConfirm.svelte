<script lang="ts">
import type { Repository } from "@revv/shared";
import { AlertDialog } from "bits-ui";
import Spinner from "phosphor-svelte/lib/Spinner";
import Trash from "phosphor-svelte/lib/Trash";
import { buttonVariants } from "$lib/components/ui/button/index.js";
import { bitsAnim, dialogSpringIn, dialogSpringOut } from "$lib/motion";
import { cn } from "$lib/utils.js";

let {
  repo,
  open = false,
  deleting = false,
  onOpenChange,
  onConfirm,
}: {
  repo: Repository | null;
  open?: boolean;
  deleting?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
} = $props();

let clonePath = $derived(repo?.clonePath ?? "the local clone path");
let unmanaged = $derived(repo?.managed === false);
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
							<Trash size={16} weight="fill" />
						</span>
						<AlertDialog.Title>
							{#snippet child({ props: titleProps })}
								<h2 {...titleProps} class="confirm-title">
									Remove {repo?.fullName ?? 'this repository'}?
								</h2>
							{/snippet}
						</AlertDialog.Title>
					</div>

					<AlertDialog.Description>
						{#snippet child({ props: descProps })}
							<p {...descProps} class="confirm-description">
								{#if unmanaged}
									Revv stops tracking it and removes its worktrees. Your clone stays where it is:
								{:else}
									This permanently deletes Revv's cloned files. This can't be undone:
								{/if}
							</p>
						{/snippet}
					</AlertDialog.Description>

					<p class="confirm-path"><code>{clonePath}</code></p>

					<div class="confirm-actions">
						<AlertDialog.Cancel
							class={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
							disabled={deleting}
						>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							class={cn(buttonVariants({ variant: 'destructive', size: 'sm' }), 'confirm-delete')}
							disabled={deleting}
							onclick={onConfirm}
						>
							{#if deleting}
								<Spinner size={13} weight="bold" class="motion-essential-spin" />
								Removing…
							{:else}
								<Trash size={13} weight="fill" />
								Remove
							{/if}
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
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-danger) 22%, transparent);
	}

	.confirm-title {
		margin: 0;
		min-width: 0;
		color: var(--color-text-primary);
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.confirm-description {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.55;
	}

	.confirm-path {
		margin: 0;
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
		border: 1px solid var(--color-border-subtle);
		padding: 7px 10px;
		color: var(--color-text-primary);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		font-size: 11.5px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.confirm-path code {
		color: inherit;
		font-family: inherit;
	}

	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}

	/* Give the Remove button a firmer destructive read than the default
	   10%-alpha fill: a hairline danger border so it never reads as a plain
	   neutral chip, while staying tonal (no solid red volume). */
	.confirm-content :global(.confirm-delete) {
		border-color: color-mix(in srgb, var(--color-danger) 28%, transparent);
		gap: 6px;
	}
</style>
