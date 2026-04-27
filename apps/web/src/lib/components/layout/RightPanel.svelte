<script lang="ts">
	import {
		X,
		Send,
		Trash2,
		Bot,
		ChevronDown,
		ChevronRight,
		Copy,
		AlertTriangle,
		Settings,
		GitCommitHorizontal,
	} from '@lucide/svelte';
	import { onMount, tick } from 'svelte';
	import {
		getChatItems,
		getChatError,
		isChatStreaming,
		getProposedChanges,
		sendChatMessage,
		clearChatHistory,
		refreshProposedChanges,
	} from '$lib/stores/chat.svelte';
	import { fetchProposedDiff } from '$lib/api/chat';
	import { renderMarkdown } from '$lib/utils/markdown';

	interface Props {
		onClose: () => void;
		prId?: string;
	}

	let { onClose, prId }: Props = $props();

	const items = $derived(prId ? getChatItems(prId) : []);
	const isStreaming = $derived(prId ? isChatStreaming(prId) : false);
	const error = $derived(prId ? getChatError(prId) : null);
	const proposed = $derived(prId ? getProposedChanges(prId) : null);
	const commitCount = $derived(proposed?.commits.length ?? 0);

	let inputValue = $state('');
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let messagesEl: HTMLDivElement | undefined = $state();
	let proposedExpanded = $state(false);
	let diffOpen = $state<{ sha: string; subject: string; body: string } | null>(null);

	// Auto-grow textarea up to ~3 lines.
	$effect(() => {
		// Track inputValue to retrigger.
		void inputValue;
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		const max = 96; // ~3 lines at 13px line-height
		textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, max)}px`;
	});

	// Auto-scroll to bottom on new content.
	$effect(() => {
		// Track items length AND streaming state so we re-scroll on new chunks.
		void items.length;
		void isStreaming;
		if (!messagesEl) return;
		void tick().then(() => {
			if (messagesEl) {
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
		});
	});

	// Pull proposed-changes count when the panel mounts on a new PR.
	onMount(() => {
		if (prId) void refreshProposedChanges(prId);
	});

	function handleSubmit(e?: Event): void {
		e?.preventDefault();
		if (!prId) return;
		const value = inputValue.trim();
		if (value.length === 0 || isStreaming) return;
		sendChatMessage({ prId, message: value });
		inputValue = '';
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	}

	async function handleClear(): Promise<void> {
		if (!prId) return;
		await clearChatHistory(prId);
	}

	async function openDiff(commit: { sha: string; subject: string }): Promise<void> {
		if (!prId) return;
		try {
			const body = await fetchProposedDiff(prId, commit.sha);
			diffOpen = { sha: commit.sha, subject: commit.subject, body };
		} catch {
			// Best-effort — failures are silent; the user can retry.
		}
	}

	function copyToClipboard(text: string): void {
		void navigator.clipboard?.writeText(text);
	}

	function assistantHtml(content: string): string {
		return content ? renderMarkdown(content) : '';
	}
</script>

<div class="panel">
	<!-- Header -->
	<div class="panel-header">
		{#if isStreaming}
			<div class="streaming-dots" aria-label="AI is thinking…">
				<span></span><span></span><span></span>
			</div>
		{:else}
			<span class="panel-title">Chat</span>
		{/if}
		<div class="header-actions">
			{#if items.length > 0}
				<button
					class="icon-btn"
					onclick={handleClear}
					title="Clear conversation"
					aria-label="Clear conversation"
				>
					<Trash2 size={13} />
				</button>
			{/if}
			<button class="icon-btn" onclick={onClose} aria-label="Close panel">
				<X size={14} />
			</button>
		</div>
	</div>

	<!-- Proposed changes strip -->
	{#if commitCount > 0 && proposed}
		<div class="proposed-strip">
			<button
				class="proposed-summary"
				onclick={() => (proposedExpanded = !proposedExpanded)}
				aria-expanded={proposedExpanded}
			>
				{#if proposedExpanded}
					<ChevronDown size={12} />
				{:else}
					<ChevronRight size={12} />
				{/if}
				<GitCommitHorizontal size={12} />
				<span class="proposed-count">
					{commitCount} commit{commitCount === 1 ? '' : 's'} proposed
				</span>
				{#if proposed.branchName}
					<span class="proposed-branch">{proposed.branchName}</span>
				{/if}
			</button>
			{#if proposedExpanded}
				<ul class="proposed-list">
					{#each proposed.commits as commit (commit.sha)}
						<li class="proposed-item">
							<div class="proposed-row">
								<code class="proposed-sha">{commit.shortSha}</code>
								<span class="proposed-subject" title={commit.subject}>
									{commit.subject}
								</span>
								<button
									class="proposed-icon-btn"
									title="Copy SHA"
									aria-label="Copy SHA"
									onclick={() => copyToClipboard(commit.sha)}
								>
									<Copy size={11} />
								</button>
								<button
									class="proposed-icon-btn"
									title="View diff"
									onclick={() => void openDiff(commit)}
								>
									Diff
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<!-- Messages -->
	<div class="panel-content" bind:this={messagesEl}>
		{#if items.length === 0 && !error}
			<div class="empty-state">
				<Bot size={32} class="empty-icon" />
				<p class="empty-primary">Ask the agent about this pull request</p>
				<p class="empty-hint">
					The agent runs inside the PR's worktree and can read the code, propose fixes,
					and commit them on a working branch.
				</p>
				<p class="empty-examples">
					Try: <em>"What's the riskiest change here?"</em><br />
					or <em>"Fix the SQL injection in auth.ts and commit it."</em>
				</p>
			</div>
		{:else}
			<ul class="messages">
				{#each items as item (item.id)}
					{#if item.kind === 'tool'}
						<li class="tool-line">
							<span class="tool-bullet">›</span>
							<span class="tool-text">{item.description}</span>
						</li>
					{:else if item.role === 'user'}
						<li class="msg msg--user">
							<span class="msg-label">You</span>
							<div class="msg-body msg-body--user">{item.content}</div>
						</li>
					{:else}
						<li class="msg msg--assistant">
							<span class="msg-label">Agent</span>
							<div class="msg-body msg-body--assistant">
								{#if item.content}
									{@html assistantHtml(item.content)}
								{:else if item.isStreaming}
									<div class="skeleton-line"></div>
								{/if}
								{#if item.isStreaming}
									<span class="stream-cursor" aria-hidden="true"></span>
								{/if}
							</div>
						</li>
					{/if}
				{/each}
			</ul>
		{/if}

		{#if error && !isStreaming}
			<div class="error-state">
				{#if error.code === 'NOT_CONFIGURED'}
					<Settings size={24} class="error-icon" />
					<p class="error-primary">AI not configured</p>
					<p class="error-hint">
						Install <a href="https://opencode.ai" class="error-link">opencode</a>
						or <a href="https://claude.ai/code" class="error-link">Claude Code</a>
						and authenticate, then select your CLI agent in <a href="/settings" class="error-link">Settings</a>.
					</p>
				{:else if error.code === 'RATE_LIMITED'}
					<AlertTriangle size={24} class="error-icon" />
					<p class="error-primary">Rate limited</p>
					<p class="error-hint">{error.message}</p>
				{:else}
					<AlertTriangle size={24} class="error-icon" />
					<p class="error-primary">Chat failed</p>
					<p class="error-hint">{error.message}</p>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Input -->
	<form class="input-row" onsubmit={handleSubmit}>
		<textarea
			bind:this={textareaEl}
			bind:value={inputValue}
			class="input-textarea"
			placeholder="Ask anything…"
			rows="1"
			onkeydown={handleKeydown}
			disabled={!prId}
		></textarea>
		<button
			class="send-btn"
			type="submit"
			disabled={!prId || inputValue.trim().length === 0 || isStreaming}
			aria-label="Send message"
		>
			<Send size={14} />
		</button>
	</form>
</div>

<!-- Diff overlay -->
{#if diffOpen}
	<div
		class="diff-overlay"
		role="dialog"
		aria-modal="true"
		aria-label="Proposed commit diff"
	>
		<button
			type="button"
			class="diff-overlay-backdrop"
			aria-label="Close diff"
			onclick={() => (diffOpen = null)}
		></button>
		<div class="diff-card" role="document">
			<div class="diff-card-header">
				<code class="diff-card-sha">{diffOpen.sha.slice(0, 12)}</code>
				<span class="diff-card-subject">{diffOpen.subject}</span>
				<button
					class="icon-btn"
					onclick={() => (diffOpen = null)}
					aria-label="Close diff"
				>
					<X size={14} />
				</button>
			</div>
			<pre class="diff-card-body"><code>{diffOpen.body}</code></pre>
		</div>
	</div>
{/if}

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && diffOpen) {
			diffOpen = null;
		}
	}}
/>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--color-panel-bg);
		overflow: hidden;
	}

	/* Header */
	.panel-header {
		height: 40px;
		border-bottom: 1px solid var(--color-border-subtle);
		padding: 0 8px 0 12px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-shrink: 0;
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--color-panel-header-bg);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}

	.panel-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	/* Streaming dots */
	.streaming-dots {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.streaming-dots span {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: dot-pulse 1.2s ease-in-out infinite;
	}

	.streaming-dots span:nth-child(2) {
		animation-delay: 0.2s;
	}

	.streaming-dots span:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes dot-pulse {
		0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
		40% { opacity: 1; transform: scale(1); }
	}

	.icon-btn {
		width: 24px;
		height: 24px;
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

	.icon-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	/* Proposed-changes strip */
	.proposed-strip {
		flex-shrink: 0;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
	}

	.proposed-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: 11px;
		color: var(--color-text-secondary);
		text-align: left;
	}

	.proposed-summary:hover {
		background: var(--color-bg-tertiary);
	}

	.proposed-count {
		font-weight: 600;
		color: var(--color-accent);
	}

	.proposed-branch {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-text-muted);
		margin-left: auto;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 140px;
	}

	.proposed-list {
		list-style: none;
		margin: 0;
		padding: 0 12px 8px;
		max-height: 160px;
		overflow-y: auto;
	}

	.proposed-item {
		padding: 4px 0;
		border-top: 1px solid var(--color-border-subtle);
	}

	.proposed-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.proposed-sha {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.proposed-subject {
		font-size: 11px;
		color: var(--color-text-primary);
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.proposed-icon-btn {
		font-size: 10px;
		font-family: var(--font-mono);
		color: var(--color-text-muted);
		background: transparent;
		border: none;
		border-radius: 3px;
		padding: 2px 6px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 3px;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.proposed-icon-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	/* Content / messages */
	.panel-content {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.messages {
		list-style: none;
		margin: 0;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.msg {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.msg-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.msg-body {
		font-size: 13px;
		line-height: 1.55;
		color: var(--color-text-primary);
		word-wrap: break-word;
	}

	.msg-body--user {
		white-space: pre-wrap;
	}

	.msg-body--assistant :global(h2) {
		font-size: 14px;
		font-weight: 600;
		margin: 12px 0 4px;
	}
	.msg-body--assistant :global(h3) {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
		margin: 10px 0 4px;
	}
	.msg-body--assistant :global(p) { margin: 4px 0; }
	.msg-body--assistant :global(ul),
	.msg-body--assistant :global(ol) { margin: 4px 0; padding-left: 18px; }
	.msg-body--assistant :global(li) { margin: 2px 0; }
	.msg-body--assistant :global(strong) { font-weight: 600; }
	.msg-body--assistant :global(code) {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
	}
	.msg-body--assistant :global(pre) {
		margin: 6px 0;
		padding: 8px 10px;
		background: var(--color-diff-bg);
		border-radius: 4px;
		overflow-x: auto;
	}
	.msg-body--assistant :global(pre code) {
		background: none;
		padding: 0;
		font-size: 11px;
		line-height: 1.5;
	}
	.msg-body--assistant :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.msg-body--assistant :global(blockquote) {
		border-left: 2px solid var(--color-border-subtle);
		margin: 8px 0;
		padding: 2px 10px;
		color: var(--color-text-secondary);
	}

	/* Tool-use line */
	.tool-line {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 11px;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
	}

	.tool-bullet {
		color: var(--color-accent);
	}

	.tool-text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Skeleton + cursor */
	.skeleton-line {
		height: 13px;
		width: 60%;
		border-radius: 3px;
		background: linear-gradient(
			90deg,
			var(--color-bg-tertiary) 25%,
			var(--color-bg-elevated) 50%,
			var(--color-bg-tertiary) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	@keyframes shimmer {
		from { background-position: 200% 0; }
		to { background-position: -200% 0; }
	}

	.stream-cursor {
		display: inline-block;
		width: 2px;
		height: 14px;
		background: var(--color-stream-cursor, var(--color-accent));
		border-radius: 1px;
		margin-left: 1px;
		vertical-align: text-bottom;
		animation: stream-cursor-blink 800ms ease-in-out infinite;
	}

	@keyframes stream-cursor-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.2; }
	}

	/* Empty state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 100%;
		padding: 32px 24px;
		text-align: center;
		gap: 8px;
	}

	:global(.empty-icon) { color: var(--color-text-muted); margin-bottom: 4px; }

	.empty-primary {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-secondary);
		margin: 0;
	}

	.empty-hint, .empty-examples {
		font-size: 11px;
		color: var(--color-text-muted);
		margin: 0;
		line-height: 1.5;
	}

	.empty-examples em {
		font-style: italic;
		color: var(--color-text-secondary);
	}

	/* Error states */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 24px;
		text-align: center;
		gap: 6px;
	}

	:global(.error-icon) {
		color: var(--color-text-muted);
		margin-bottom: 4px;
	}

	.error-primary {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-secondary);
		margin: 0;
	}

	.error-hint {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.error-link {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* Input row */
	.input-row {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		padding: 8px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-panel-bg);
		flex-shrink: 0;
	}

	.input-textarea {
		flex: 1;
		min-height: 28px;
		max-height: 96px;
		padding: 6px 10px;
		font-size: 13px;
		line-height: 1.4;
		font-family: inherit;
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
		border: 1px solid var(--color-border-subtle);
		border-radius: 6px;
		resize: none;
		outline: none;
		transition: border-color var(--duration-snap);
	}

	.input-textarea:focus {
		border-color: var(--color-accent);
	}

	.send-btn {
		width: 30px;
		height: 30px;
		border-radius: 6px;
		border: none;
		background: var(--color-accent);
		color: var(--color-bg-primary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: opacity var(--duration-snap);
	}

	.send-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Diff overlay */
	.diff-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.diff-overlay-backdrop {
		position: absolute;
		inset: 0;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		cursor: default;
		padding: 0;
		margin: 0;
	}

	.diff-card {
		position: relative;
	}

	.diff-card {
		max-width: min(900px, 90vw);
		max-height: 80vh;
		background: var(--color-panel-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.diff-card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
	}

	.diff-card-sha {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.diff-card-subject {
		font-size: 13px;
		color: var(--color-text-primary);
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.diff-card-body {
		margin: 0;
		padding: 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.5;
		overflow: auto;
	}
</style>
