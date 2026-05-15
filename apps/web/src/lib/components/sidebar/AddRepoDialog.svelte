<script lang="ts">
import AddRepoForm from "./AddRepoForm.svelte";

let { open = false, onClose }: { open?: boolean; onClose: () => void } = $props();

function handleKey(e: KeyboardEvent) {
  if (e.key === "Escape") onClose();
}
</script>

{#if open}
	<!-- Backdrop -->
	<div
		class="backdrop"
		role="presentation"
		onclick={onClose}
		onkeydown={handleKey}
	></div>

	<!-- Dialog -->
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-label="Add repository"
		tabindex="-1"
		onkeydown={handleKey}
	>
		<div class="dialog-inner">
			<AddRepoForm {onClose} />
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(6px) saturate(1.1);
		-webkit-backdrop-filter: blur(6px) saturate(1.1);
		animation: backdrop-in var(--duration-quick) var(--ease-soft) both;
	}

	.dialog {
		position: fixed;
		left: 50%;
		top: 50%;
		z-index: 50;
		width: 480px;
		max-width: calc(100vw - 2rem);
		max-height: min(580px, 82vh);
		display: flex;
		flex-direction: column;
		border-radius: 14px;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.08));
		box-shadow:
			0 20px 60px -10px rgba(0, 0, 0, 0.55),
			0 8px 24px -8px rgba(0, 0, 0, 0.4),
			inset 0 0.5px 0 0 var(--color-glass-highlight, rgba(255, 255, 255, 0.06));
		animation: dialog-in var(--duration-smooth) var(--ease-out-expo) both;
		overflow: hidden;
	}

	.dialog::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 14px;
		padding: 1px;
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--color-text-primary) 12%, transparent),
			transparent 35%
		);
		mask:
			linear-gradient(#000, #000) content-box,
			linear-gradient(#000, #000);
		-webkit-mask:
			linear-gradient(#000, #000) content-box,
			linear-gradient(#000, #000);
		mask-composite: exclude;
		-webkit-mask-composite: xor;
		pointer-events: none;
	}

	.dialog-inner {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: 20px;
	}

	@keyframes backdrop-in {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@keyframes dialog-in {
		0% {
			opacity: 0;
			transform: translate(-50%, calc(-50% + 8px)) scale(0.97);
		}
		100% {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.backdrop,
		.dialog {
			animation: none;
		}
		.dialog {
			transform: translate(-50%, -50%);
		}
	}
</style>
