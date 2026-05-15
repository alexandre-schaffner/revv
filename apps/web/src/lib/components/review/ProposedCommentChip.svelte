<script lang="ts">
import { Pencil, Trash2 } from "@lucide/svelte";

interface Props {
  body: string;
  onEdit: () => void;
  onDelete: () => void;
}

let { body, onEdit, onDelete }: Props = $props();
</script>

<div class="chip">
	<div class="chip-body">{body}</div>
	<div class="chip-actions">
		<button
			type="button"
			class="chip-btn"
			onclick={onEdit}
			title="Edit comment"
			aria-label="Edit comment"
		>
			<Pencil size={11} />
		</button>
		<button
			type="button"
			class="chip-btn"
			onclick={onDelete}
			title="Delete comment"
			aria-label="Delete comment"
		>
			<Trash2 size={11} />
		</button>
	</div>
</div>

<style>
	.chip {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		background: var(--color-input-bg);
		border-top: 1px solid var(--color-border);
		border-left: 2px solid var(--color-accent);
		padding: 6px 10px;
	}

	.chip-body {
		flex: 1;
		min-width: 0;
		font-family: var(--font-sans);
		font-size: 12px;
		line-height: 1.6;
		color: var(--color-text-primary);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.chip-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.chip-btn {
		width: 22px;
		height: 22px;
		border-radius: 4px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.chip-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}
</style>
