<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		filePath: string;
		lineNo: number;
		onSubmit: (body: string) => void;
		onDismiss: () => void;
	}

	let { filePath: _filePath, lineNo: _lineNo, onSubmit, onDismiss }: Props = $props();

	let body = $state('');
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
		background: var(--color-input-bg, #16161a);
		border-top: 1px solid var(--color-border, #2a2a32);
		border-left: 2px solid var(--color-accent, #3b82f6);
		padding: 6px 10px;
		transition: border-color 80ms;
	}

	.comment-input--focused {
		border-left-color: var(--color-accent, #3b82f6);
		background: var(--color-bg-elevated, #1a1a1f);
	}

	.textarea {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		resize: none;
		font-family: var(--font-sans, system-ui, sans-serif);
		font-size: 12px;
		line-height: 1.6;
		color: var(--color-text-primary, #e4e4e7);
		min-height: 20px;
		max-height: 68px;
		overflow-y: auto;
	}

	.textarea::placeholder {
		color: var(--color-text-muted, #888);
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
		background: var(--color-bg-tertiary, #2a2a32);
		color: var(--color-text-muted, #888);
		cursor: default;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background-color 80ms, color 80ms;
	}

	.submit-btn--active {
		background: var(--color-accent, #3b82f6);
		color: white;
		cursor: pointer;
	}

	.submit-btn--active:hover {
		background: var(--color-accent-hover, #2563eb);
	}

	.submit-btn:disabled {
		cursor: default;
	}
</style>
