<script lang="ts">
	interface Props {
		tokenText: string;
		x: number;
		y: number;
		onExplain?: () => void;
		onDismiss?: () => void;
	}

	let { tokenText, x, y, onExplain, onDismiss }: Props = $props();

	let tooltipEl: HTMLDivElement | undefined = $state();

	// Position the tooltip above the token, clamped to viewport width
	const posLeft = $derived.by(() => {
		if (!tooltipEl) return x;
		const w = tooltipEl.offsetWidth;
		return Math.min(x, window.innerWidth - w - 8);
	});

	const posTop = $derived(y - 44);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onDismiss?.();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	bind:this={tooltipEl}
	class="token-tooltip"
	style="left: {posLeft}px; top: {posTop}px;"
	role="tooltip"
>
	<code class="token-text">{tokenText}</code>
	{#if onExplain}
		<div class="sep"></div>
		<button class="explain-btn" onclick={onExplain}>
			<svg
				width="11"
				height="11"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				aria-hidden="true"
			>
				<path
					d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
				/>
				<path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" />
			</svg>
			Explain
		</button>
	{/if}
</div>

<style>
	.token-tooltip {
		position: fixed;
		z-index: 300;
		display: flex;
		align-items: center;
		gap: 0;
		background: var(--color-tooltip-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-tooltip-border);
		border-radius: 6px;
		padding: 3px 4px 3px 10px;
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-tooltip-item-bg);
		pointer-events: auto;
		animation: tt-in 70ms ease-out both;
		max-width: 320px;
		white-space: nowrap;
		overflow: hidden;
	}


	@keyframes tt-in {
		from {
			opacity: 0;
			transform: translateY(3px) scale(0.96);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.token-text {
		position: relative;
		z-index: 1;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 200px;
	}

	.sep {
		position: relative;
		z-index: 1;
		width: 1px;
		height: 14px;
		background: var(--color-tooltip-border);
		margin: 0 6px;
		flex-shrink: 0;
	}

	.explain-btn {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 500;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-ai-accent) 12%, transparent);
		border: none;
		border-radius: 4px;
		padding: 3px 8px;
		cursor: pointer;
		flex-shrink: 0;
		transition: background-color 80ms;
	}

	.explain-btn:hover {
		background: color-mix(in srgb, var(--color-ai-accent) 22%, transparent);
	}
</style>
