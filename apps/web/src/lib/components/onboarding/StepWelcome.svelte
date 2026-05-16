<script lang="ts">
interface Props {
  onContinue: () => void;
}

let { onContinue }: Props = $props();
</script>

<div class="welcome">
	<p class="lede">
		A quieter place to read pull requests. Walkthroughs, ratings, and threads
		that sync back to GitHub — built around the way reviewers actually think.
	</p>

	<div class="actions">
		<button class="primary" onclick={onContinue}>
			<span>Begin</span>
			<svg
				width="18"
				height="10"
				viewBox="0 0 18 10"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				aria-hidden="true"
			>
				<path d="M0 5h16M12 1l4 4-4 4" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
		<span class="hint">A minute, no more.</span>
	</div>
</div>

<style>
	.welcome {
		display: flex;
		flex-direction: column;
		gap: 36px;
		max-width: 520px;
	}

	.lede {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 19px;
		font-weight: 400;
		line-height: 1.55;
		color: var(--ob-text-body);
		margin: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 18px;
		animation: actions-in var(--duration-ceremonial-slow) var(--ease-out-expo) 400ms backwards;
	}

	@keyframes actions-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.primary {
		display: inline-flex;
		align-items: center;
		gap: 14px;
		padding: 12px 22px;
		border: 1px solid var(--ob-border-btn);
		border-radius: 2px;
		background: transparent;
		color: var(--ob-text-heading);
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 16px;
		font-weight: 500;
		cursor: pointer;
		letter-spacing: 0.01em;
		transition:
			background-color var(--duration-snap) var(--ease-out-expo),
			border-color var(--duration-snap) var(--ease-out-expo),
			color var(--duration-snap) var(--ease-out-expo),
			transform var(--duration-smooth) var(--ease-out-expo);
	}

	.primary svg {
		transition: transform var(--duration-smooth) var(--ease-out-expo);
	}

	.primary:hover {
		border-color: var(--ob-text-italic);
		color: var(--ob-text-heading-bright);
	}

	.primary:hover svg {
		transform: translateX(4px);
	}

	.primary:active {
		transform: scale(0.99);
	}

	.hint {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ob-text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.actions {
			animation: none;
		}
	}
</style>
