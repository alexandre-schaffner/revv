<script lang="ts">
import { AlertDialog } from "bits-ui";
import Spinner from "phosphor-svelte/lib/Spinner";
import type { Component, Snippet } from "svelte";
import { buttonVariants } from "$lib/components/ui/button/index.js";
import {
  bitsAnim,
  dialogSpringIn,
  dialogSpringOut,
  overlayFadeIn,
  overlayFadeOut,
} from "$lib/motion";
import { cn } from "$lib/utils.js";

type Icon = Component<{ size?: number | string; class?: string }>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Colours the header icon; `danger` also makes the confirm button destructive. */
  tone: "success" | "warning" | "danger";
  icon: Icon;
  title: string;
  description: Snippet;
  /** Extra content between the description and the actions. */
  body?: Snippet;
  confirmLabel: string;
  confirmIcon: Icon;
  onConfirm: () => void;
  /** While true both buttons are disabled and the confirm button shows `pendingLabel`. */
  pending?: boolean;
  pendingLabel?: string;
  width?: number;
}

let {
  open,
  onOpenChange,
  tone,
  icon: HeaderIcon,
  title,
  description,
  body,
  confirmLabel,
  confirmIcon: ConfirmIcon,
  onConfirm,
  pending = false,
  pendingLabel,
  width = 408,
}: Props = $props();
</script>

<AlertDialog.Root {open} {onOpenChange}>
	<AlertDialog.Portal>
		<AlertDialog.Overlay>
			{#snippet child({ props })}
				<div
					{...props}
					class="confirm-overlay"
					data-glass
					use:bitsAnim={{ inPreset: overlayFadeIn, outPreset: overlayFadeOut }}
				></div>
			{/snippet}
		</AlertDialog.Overlay>
		<AlertDialog.Content>
			{#snippet child({ props })}
				<div
					{...props}
					class="confirm-content"
					style:--confirm-width="{width}px"
					data-glass
					use:bitsAnim={{ inPreset: dialogSpringIn, outPreset: dialogSpringOut }}
				>
					<div class="confirm-header">
						<span class="confirm-icon confirm-icon--{tone}" aria-hidden="true">
							<HeaderIcon size={16} />
						</span>
						<AlertDialog.Title>
							{#snippet child({ props: titleProps })}
								<h2 {...titleProps} class="confirm-title">{title}</h2>
							{/snippet}
						</AlertDialog.Title>
					</div>

					<AlertDialog.Description>
						{#snippet child({ props: descProps })}
							<p {...descProps} class="confirm-description">{@render description()}</p>
						{/snippet}
					</AlertDialog.Description>

					{@render body?.()}

					<div class="confirm-actions">
						<AlertDialog.Cancel
							class={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
							disabled={pending}
						>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							class={cn(
								buttonVariants({ variant: tone === 'danger' ? 'destructive' : 'default', size: 'sm' }),
								'confirm-action',
								tone === 'danger' && 'confirm-action--danger',
							)}
							disabled={pending}
							onclick={onConfirm}
						>
							{#if pending}
								<Spinner size={13} class="motion-essential-spin" />
								{pendingLabel ?? confirmLabel}
							{:else}
								<ConfirmIcon size={13} />
								{confirmLabel}
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
		width: min(var(--confirm-width), calc(100vw - 32px));
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
		--tone: var(--color-success);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 8px;
		background: color-mix(in srgb, var(--tone) 12%, transparent);
		color: var(--tone);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 22%, transparent);
	}

	.confirm-icon--warning {
		--tone: var(--color-warning);
	}

	.confirm-icon--danger {
		--tone: var(--color-danger);
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
		overflow-wrap: anywhere;
	}

	.confirm-description :global(code) {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}

	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}

	.confirm-content :global(.confirm-action) {
		gap: 6px;
	}

	/* A hairline danger border so the destructive button never reads as a
	   plain neutral chip, while staying tonal (no solid red volume). */
	.confirm-content :global(.confirm-action--danger) {
		border-color: color-mix(in srgb, var(--color-danger) 28%, transparent);
	}
</style>
