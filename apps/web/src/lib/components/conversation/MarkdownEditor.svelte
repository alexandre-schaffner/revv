<script lang="ts">
import Eye from "phosphor-svelte/lib/Eye";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import { onMount } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";
import SegmentedControl from "$lib/components/ui/segmented-control/SegmentedControl.svelte";
import { renderMarkdown } from "$lib/utils/markdown";
import { interceptExternalLinks } from "$lib/utils/open-external";

// The one markdown editing surface on the Conversation tab: the composer,
// a comment being edited, the PR description being edited. Write / Preview
// like GitHub's, ⌘↵ submits, Esc cancels.

interface Props {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  /** Resolves true when the text landed; the editor then clears or closes. */
  onsubmit: (body: string) => Promise<boolean>;
  oncancel?: () => void;
  /** An empty submission is meaningful (clearing a description). */
  allowEmpty?: boolean;
  autofocus?: boolean;
  /** Lets the parent focus the textarea (the `c` shortcut). */
  textarea?: HTMLTextAreaElement | null;
}

let {
  initial = "",
  placeholder,
  submitLabel,
  onsubmit,
  oncancel,
  allowEmpty = false,
  autofocus = false,
  textarea = $bindable(null),
}: Props = $props();

type Mode = "write" | "preview";

// The editor owns its draft once opened; `initial` only seeds it.
// svelte-ignore state_referenced_locally
let body = $state(initial);
let mode = $state<Mode>("write");
let submitting = $state(false);

const canSubmit = $derived(!submitting && (allowEmpty || body.trim().length > 0));
const preview = $derived(mode === "preview" ? renderMarkdown(body) : "");

function autosize(): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

async function submit(): Promise<void> {
  if (!canSubmit) return;
  submitting = true;
  const landed = await onsubmit(body);
  submitting = false;
  if (landed && !oncancel) {
    body = "";
    mode = "write";
    queueMicrotask(autosize);
  }
}

function onkeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
  } else if (e.key === "Escape" && oncancel) {
    e.preventDefault();
    e.stopPropagation();
    oncancel();
  }
}

onMount(() => {
  autosize();
  if (autofocus) textarea?.focus();
});
</script>

<div class="editor" class:editor--busy={submitting}>
	<div class="editor-head">
		<SegmentedControl
			options={[
				{ value: 'write', label: 'Write', icon: PencilSimple },
				{ value: 'preview', label: 'Preview', icon: Eye },
			]}
			value={mode}
			onValueChange={(next) => {
				mode = next;
				if (next === 'write') queueMicrotask(() => textarea?.focus());
			}}
			aria-label="Editor mode"
		/>
		<span class="editor-hint">Markdown supported</span>
	</div>

	{#if mode === 'write'}
		<textarea
			bind:this={textarea}
			bind:value={body}
			class="editor-input"
			{placeholder}
			rows="3"
			disabled={submitting}
			oninput={autosize}
			{onkeydown}
		></textarea>
	{:else}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="editor-preview prose prose-sm prose-dense" onclick={interceptExternalLinks}>
			{#if body.trim()}
				{@html preview}
			{:else}
				<p class="editor-empty">Nothing to preview.</p>
			{/if}
		</div>
	{/if}

	<div class="editor-foot">
		<span class="editor-keys"><kbd>⌘</kbd><kbd>↵</kbd> to {submitLabel.toLowerCase()}</span>
		<div class="editor-actions">
			{#if oncancel}
				<Button variant="ghost" size="sm" onclick={oncancel} disabled={submitting}>Cancel</Button>
			{/if}
			<Button size="sm" onclick={() => void submit()} disabled={!canSubmit}>
				{submitting ? 'Saving…' : submitLabel}
			</Button>
		</div>
	</div>
</div>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
	}

	.editor:focus-within {
		border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent);
	}

	.editor--busy {
		opacity: 0.7;
	}

	.editor-head,
	.editor-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 10px;
	}

	.editor-head {
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.editor-hint,
	.editor-keys {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.editor-keys kbd {
		font: inherit;
		font-family: var(--font-mono);
		padding: 0 3px;
	}

	.editor-input {
		display: block;
		width: 100%;
		min-height: 84px;
		max-height: 480px;
		padding: 12px;
		border: none;
		outline: none;
		resize: none;
		background: transparent;
		color: var(--color-text-primary);
		font: inherit;
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.editor-input::placeholder {
		color: var(--color-text-muted);
	}

	.editor-preview {
		min-height: 84px;
		max-width: none;
		padding: 12px;
	}

	.editor-empty {
		color: var(--color-text-muted);
	}

	.editor-foot {
		border-top: 1px solid var(--color-border-subtle);
	}

	.editor-actions {
		display: flex;
		gap: 6px;
	}
</style>
