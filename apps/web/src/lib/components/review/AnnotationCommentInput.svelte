<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';

	interface Props {
		filePath: string;
		lineNo: number;
		onSubmit: (body: string) => void;
		onDismiss: () => void;
		initialBody?: string;
	}

	let {
		filePath: _filePath,
		lineNo: _lineNo,
		onSubmit,
		onDismiss,
		initialBody = '',
	}: Props = $props();

	// `initialBody` seeds the textarea on mount only — later prop changes are
	// intentionally ignored, so capture the current value with `untrack`.
	let body = $state(untrack(() => initialBody));
	let focused = $state(false);
	let textareaEl: HTMLTextAreaElement | undefined = $state();

	const hasContent = $derived(body.trim().length > 0);

	function autoResize() {
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		const maxH = 3 * 20 + 8;
		textareaEl.style.height = Math.min(textareaEl.scrollHeight, maxH) + 'px';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onDismiss();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && hasContent) {
			e.preventDefault();
			onSubmit(body.trim());
		}
	}

	// Global Escape handler so dismissal works even when textarea is blurred
	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onDismiss();
		}
	}

	function handleSubmit() {
		if (!hasContent) return;
		onSubmit(body.trim());
	}

	onMount(() => {
		textareaEl?.focus();
		// Move caret to the end and right-size the box when an initial body is
		// pre-filled (used for editing an existing comment).
		if (textareaEl && body.length > 0) {
			textareaEl.setSelectionRange(body.length, body.length);
			autoResize();
		}
		window.addEventListener('keydown', handleGlobalKeydown);
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleGlobalKeydown);
	});
</script>

<div class="comment-input" class:comment-input--focused={focused}>
	<textarea
		bind:this={textareaEl}
		bind:value={body}
		class="textarea"
		placeholder="Add a comment… (⌘↵ to submit)"
		rows="1"
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
		oninput={autoResize}
		onkeydown={handleKeydown}
	></textarea>

	<div class="actions">
		<button
			class="submit-btn"
			class:submit-btn--active={hasContent}
			disabled={!hasContent}
			onclick={handleSubmit}
			title="Submit comment (⌘↵)"
			aria-label="Submit comment"
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<line x1="5" y1="12" x2="19" y2="12" />
				<polyline points="12 5 19 12 12 19" />
			</svg>
		</button>
	</div>
</div>

<style>
	.comment-input {
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--color-input-bg);
		border: 1px solid var(--color-border-subtle);
		border-radius: 6px;
		margin: 8px 0 0;
		padding: 6px 10px;
		transition:
			box-shadow var(--duration-snap) var(--ease-soft),
			border-color var(--duration-snap) var(--ease-soft);
	}

	.comment-input--focused {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px var(--color-input-focus-ring);
		background: var(--color-bg-elevated);
	}

	.textarea {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		resize: none;
		font-family: var(--font-sans);
		font-size: 12px;
		line-height: 1.6;
		color: var(--color-text-primary);
		min-height: 20px;
		max-height: 68px;
		overflow-y: auto;
	}

	.textarea::placeholder {
		color: var(--color-text-muted);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.submit-btn {
		width: 22px;
		height: 22px;
		border-radius: 4px;
		border: none;
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
		cursor: default;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background-color var(--duration-instant) var(--ease-soft), color var(--duration-instant) var(--ease-soft);
	}

	.submit-btn--active {
		background: var(--color-accent);
		color: var(--color-primary-foreground);
		cursor: pointer;
	}

	.submit-btn--active:hover {
		background: var(--color-accent-hover);
	}

	.submit-btn:disabled {
		cursor: default;
	}
</style>
