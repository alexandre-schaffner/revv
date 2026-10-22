<script lang="ts">
import Minus from "phosphor-svelte/lib/Minus";
import Plus from "phosphor-svelte/lib/Plus";

// A bounded integer: −/+ around a typed field. The buttons commit at once;
// typing commits like CommitInput (blur / Enter, Esc reverts). Every path
// clamps to [min, max], so the parent only ever sees a legal value.

interface Props {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
  "aria-label": string;
}

let { id, value, min, max, step = 1, onCommit, "aria-label": ariaLabel }: Props = $props();

let draft = $state("");
let focused = false;

$effect.pre(() => {
  const next = value;
  if (!focused) draft = String(next);
});

function clamp(n: number): number {
  return Math.min(max, Math.max(min, n));
}

function commitNumber(n: number): void {
  const next = clamp(n);
  draft = String(next);
  if (next !== value) onCommit(next);
}

function commitDraft(): void {
  const parsed = Number.parseInt(draft, 10);
  if (!Number.isFinite(parsed)) {
    draft = String(value);
    return;
  }
  commitNumber(parsed);
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    commitDraft();
  } else if (e.key === "Escape" && draft !== String(value)) {
    e.stopPropagation();
    draft = String(value);
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    commitNumber(value + (e.key === "ArrowUp" ? step : -step));
  }
}
</script>

<div class="stepper" role="group" aria-label={ariaLabel}>
	<button
		type="button"
		class="stepper-btn"
		aria-label="Decrease"
		disabled={value <= min}
		onclick={() => commitNumber(value - step)}
	>
		<Minus size={12} />
	</button>
	<input
		{id}
		class="stepper-input"
		inputmode="numeric"
		aria-label={ariaLabel}
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		role="spinbutton"
		bind:value={draft}
		onfocus={() => (focused = true)}
		onblur={() => {
			focused = false;
			commitDraft();
		}}
		onkeydown={handleKeydown}
	/>
	<button
		type="button"
		class="stepper-btn"
		aria-label="Increase"
		disabled={value >= max}
		onclick={() => commitNumber(value + step)}
	>
		<Plus size={12} />
	</button>
</div>

<style>
	.stepper {
		display: inline-flex;
		align-items: center;
		height: 30px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	:global(.dark) .stepper {
		background: var(--color-bg-elevated);
	}

	.stepper:focus-within {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.stepper-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 100%;
		border: none;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition:
			color var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo);
	}

	.stepper-btn:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
	}

	.stepper-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.stepper-input {
		width: 48px;
		height: 100%;
		border: none;
		border-inline: 1px solid var(--color-border-subtle);
		background: transparent;
		color: var(--color-text-primary);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		text-align: center;
		outline: none;
	}
</style>
