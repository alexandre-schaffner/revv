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
		Upload,
		Loader2,
		Square,
		GitBranch,
		RefreshCw,
		GitMerge,
	} from '@lucide/svelte';
	import { tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut, cubicIn } from 'svelte/easing';

	const TOOL_CALL_ROW_H = 14; // px — match walkthrough's compact tool-call rows
	import {
		getChatItems,
		getChatError,
		isChatStreaming,
		getProposedChanges,
		isPushingProposed,
		isResolvingPush,
		loadChatHistory,
		sendChatMessage,
		clearChatHistory,
		refreshProposedChanges,
		pushProposed,
		resolveAndPushProposed,
		abortChatTurn,
		getWorktreeBlocked,
		isDiscardingCommit,
		isRebasingProposed,
		discardProposedCommitAction,
		rebaseAllProposedAction,
		isCherryPickingCommit,
		cherryPickProposedCommitAction,
	} from '$lib/stores/chat.svelte';
	import { getSelectedPr } from '$lib/stores/prs.svelte';
	import {
		getPrScrollPosition,
		setPrScrollPosition,
	} from '$lib/stores/review.svelte';
	import { fetchProposedDiff } from '$lib/api/chat';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { motion } from '$lib/motion';
	import ProposedDiffModal from '$lib/components/review/ProposedDiffModal.svelte';
	import {
		Root as PopoverRoot,
		Trigger as PopoverTrigger,
		Content as PopoverContent,
	} from '$lib/components/ui/popover/index.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Dotmatrix, squareVariantForId } from '$lib/components/ui/dotmatrix/index.js';
	import StreamingVerb from './StreamingVerb.svelte';

	interface Props {
		onClose: () => void;
		prId?: string;
	}

	let { onClose, prId }: Props = $props();

	const items = $derived(prId ? getChatItems(prId) : []);
	// Turn ids whose assistant bubble is still streaming. Activity rows for
	// these turns get folded into the bubble's dot-matrix loader (walkthrough
	// style) instead of rendering as standalone tool-lines, so the panel
	// stays compact during generation.
	const streamingTurnIds = $derived(
		new Set(
			items
				.filter((i) => i.kind === 'message' && i.role === 'assistant' && i.isStreaming && i.turnId)
				.map((i) => (i as { turnId: string }).turnId),
		),
	);
	const isStreaming = $derived(prId ? isChatStreaming(prId) : false);
	const error = $derived(prId ? getChatError(prId) : null);
	const proposed = $derived(prId ? getProposedChanges(prId) : null);
	const commitCount = $derived(proposed?.commits.length ?? 0);
	const isPushing = $derived(prId ? isPushingProposed(prId) : false);
	const isResolving = $derived(prId ? isResolvingPush(prId) : false);
	const blocked = $derived(prId ? getWorktreeBlocked(prId) : null);
	const isRebasing = $derived(prId ? isRebasingProposed(prId) : false);
	const selectedPr = $derived(getSelectedPr());

	const streamingTurnId = $derived(
		items.findLast((i) => i.kind === 'message' && i.role === 'assistant' && i.isStreaming)?.turnId
	);
	const recentToolCalls = $derived(
		streamingTurnId
			? items
				.filter((i) => i.kind === 'activity' && i.turnId === streamingTurnId)
				.slice(-2)
				.map((i) => i as Extract<typeof i, { kind: 'activity' }>)
			: []
	);

	let inputValue = $state('');
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let messagesEl: HTMLDivElement | undefined = $state();
	let proposedExpanded = $state(false);
	let diffOpen = $state<{ sha: string; subject: string; body: string } | null>(null);
	let conflictDialog = $state<{ files: string[]; branch: string } | null>(null);
	let pushSuccessTrigger = $state(0);
	let pushMenuOpen = $state(false);
	// "Push to new branch" dialog. `input` mode collects the branch name;
	// `confirm-overwrite` is the inline confirmation shown when the remote
	// already has that ref.
	let newBranchDialogOpen = $state(false);
	let newBranchDialogMode = $state<'input' | 'confirm-overwrite'>('input');
	let newBranchValue = $state('');
	let newBranchInputEl: HTMLInputElement | null = $state(null);

	// Auto-grow textarea up to ~3 lines.
	$effect(() => {
		// Track inputValue to retrigger.
		void inputValue;
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		const max = 96; // ~3 lines at 13px line-height
		textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, max)}px`;
	});

	// ── Per-PR scroll persistence (right pane) ──────────────────────────────
	//
	// Two flows share the same scroll container:
	//
	//   - PR switch  → restore the saved scrollTop (or land at bottom on
	//                  first visit — chat conversations grow downward, so
	//                  bottom is the "newest message" default).
	//   - Content    → auto-scroll-to-bottom on new messages/chunks, but
	//                  only if the user was already at the bottom. We don't
	//                  want to yank them out of older content they're reading.
	//
	// `wasAtBottom` is updated by the user-driven scroll handler and by the
	// programmatic restore. The content-change effect is gated on
	// `prId === lastRestoredPrId`, so a content update that arrives in the
	// same flush as a PR switch can't beat the restore to the punch.
	// `suppressNextScroll` swallows the synthetic 'scroll' event emitted when
	// we mutate scrollTop ourselves, so handleScroll doesn't immediately
	// overwrite the value we just persisted.

	const AT_BOTTOM_TOLERANCE = 4; // px — accommodates sub-pixel rounding

	let suppressNextScroll = false;
	let wasAtBottom = true;
	let lastRestoredPrId: string | undefined;

	function isAtBottom(): boolean {
		if (!messagesEl) return true;
		const distance =
			messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
		return distance <= AT_BOTTOM_TOLERANCE;
	}

	function handleScroll(): void {
		if (suppressNextScroll) {
			suppressNextScroll = false;
			return;
		}
		if (!messagesEl || !prId) return;
		setPrScrollPosition(prId, 'rightPanel', messagesEl.scrollTop);
		wasAtBottom = isAtBottom();
	}

	// Restore on PR change.
	$effect(() => {
		if (!messagesEl || !prId) return;
		if (prId === lastRestoredPrId) return;
		const incomingPrId = prId;
		lastRestoredPrId = incomingPrId;
		const saved = getPrScrollPosition(incomingPrId, 'rightPanel');
		void tick().then(() => {
			if (!messagesEl || lastRestoredPrId !== incomingPrId) return;
			suppressNextScroll = true;
			if (saved > 0) {
				messagesEl.scrollTop = saved;
				wasAtBottom = isAtBottom();
			} else {
				messagesEl.scrollTop = messagesEl.scrollHeight;
				wasAtBottom = true;
			}
		});
	});

	// Auto-scroll on new content. Skips while a PR-switch restore is still in
	// flight, so it can't race with (and clobber) the restore.
	$effect(() => {
		void items.length;
		void isStreaming;
		if (!messagesEl || !prId) return;
		if (prId !== lastRestoredPrId) return;
		if (!wasAtBottom) return;
		void tick().then(() => {
			if (!messagesEl || prId !== lastRestoredPrId) return;
			suppressNextScroll = true;
			messagesEl.scrollTop = messagesEl.scrollHeight;
			setPrScrollPosition(prId, 'rightPanel', messagesEl.scrollTop);
		});
	});

	// Hydrate on initial mount AND on PR switch. The panel is mounted once in
	// AppShell and just gets a new `prId` prop on navigation, so this $effect
	// is the only place that fires on PR switch. `loadChatHistory` is
	// idempotent (gated by `loadedPrIds`); `refreshProposedChanges` always
	// re-fetches so the strip reflects the freshly-selected PR's worktree.
	$effect(() => {
		if (prId) {
			void refreshProposedChanges(prId);
			void loadChatHistory(prId);
		}
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

	async function handlePush(): Promise<void> {
		if (!prId || isPushing || isStreaming || isResolving) return;
		const result = await pushProposed(prId);
		if (!result) return;
		if (result.status === 'pushed') {
			pushSuccessTrigger++;
		} else if (result.status === 'conflict') {
			conflictDialog = { files: result.files, branch: result.branch };
		}
		// remote-changed already toasts in the store; no extra UI here.
	}

	function suggestedNewBranchName(): string {
		const base = selectedPr?.sourceBranch?.trim();
		return base && base.length > 0 ? `${base}-agent` : 'agent-changes';
	}

	function openNewBranchDialog(): void {
		pushMenuOpen = false;
		newBranchDialogMode = 'input';
		newBranchValue = suggestedNewBranchName();
		newBranchDialogOpen = true;
		// Focus + select on the next tick so the dialog is in the DOM first.
		void tick().then(() => newBranchInputEl?.select());
	}

	function isValidNewBranchName(value: string): boolean {
		const trimmed = value.trim();
		if (trimmed.length === 0) return false;
		if (/\s/.test(trimmed)) return false;
		if (trimmed.startsWith('-')) return false;
		if (trimmed.includes('..')) return false;
		return true;
	}

	async function handleNewBranchSubmit(): Promise<void> {
		if (!prId || newBranchDialogMode !== 'input') return;
		const name = newBranchValue.trim();
		if (!isValidNewBranchName(name)) return;
		const result = await pushProposed(prId, { newBranchName: name });
		if (!result) {
			// Hard failure already toasted by the store.
			newBranchDialogOpen = false;
			return;
		}
		if (result.status === 'pushed') {
			pushSuccessTrigger++;
			newBranchDialogOpen = false;
			return;
		}
		if (result.status === 'ref-exists') {
			newBranchValue = name;
			newBranchDialogMode = 'confirm-overwrite';
			return;
		}
		// 'conflict' / 'remote-changed' don't apply to the new-branch path,
		// but if the server ever returns one we surface it as a generic close.
		newBranchDialogOpen = false;
	}

	async function handleConfirmOverwrite(): Promise<void> {
		if (!prId || newBranchDialogMode !== 'confirm-overwrite') return;
		const result = await pushProposed(prId, {
			newBranchName: newBranchValue,
			force: true,
		});
		if (!result) {
			newBranchDialogOpen = false;
			return;
		}
		if (result.status === 'pushed') {
			pushSuccessTrigger++;
		}
		newBranchDialogOpen = false;
	}

	async function handleResolveAndPush(): Promise<void> {
		if (!prId || isResolving) return;
		conflictDialog = null;
		await resolveAndPushProposed(prId);
	}

	function dismissConflictDialog(): void {
		conflictDialog = null;
	}

	function handleStop(): void {
		if (!prId) return;
		abortChatTurn(prId);
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

	function messageHtml(content: string): string {
		return content ? renderMarkdown(content) : '';
	}

	function activitiesForTurn(turnId: string | undefined): Extract<(typeof items)[number], { kind: 'activity' }>[] {
		if (!turnId) return [];
		return items.filter((i): i is Extract<(typeof items)[number], { kind: 'activity' }> => i.kind === 'activity' && i.turnId === turnId);
	}
</script>

<div class="panel">
	<!-- Header -->
	<div class="panel-header">
		<span class="panel-title">Chat</span>
		<div class="header-actions">
			{#if commitCount > 0}
				<div
					class="push-pill"
					use:motion={{ preset: 'pulse', trigger: pushSuccessTrigger }}
				>
					<button
						type="button"
						class="push-pill-main"
						onclick={handlePush}
						title={`Push ${commitCount} commit${commitCount === 1 ? '' : 's'}${selectedPr?.sourceBranch ? ` to ${selectedPr.sourceBranch}` : ''}`}
						aria-label={`Push ${commitCount} commit${commitCount === 1 ? '' : 's'} to PR branch`}
						disabled={isPushing || isStreaming || isResolving}
					>
						{#if isPushing}
							<Loader2 size={12} class="motion-essential-spin" />
							<span class="push-pill-label">Pushing…</span>
						{:else}
							<Upload size={12} />
							<span class="push-pill-label">
								Push
								<span class="push-pill-count">{commitCount}</span>
							</span>
						{/if}
					</button>
					<PopoverRoot bind:open={pushMenuOpen}>
						<PopoverTrigger>
							<button
								type="button"
								class="push-pill-chevron"
								aria-label="Push options"
								title="Push options"
								disabled={isPushing || isStreaming || isResolving}
							>
								<ChevronDown size={11} />
							</button>
						</PopoverTrigger>
						<PopoverContent class="w-72 p-1" align="end" side="bottom">
							<button
								type="button"
								class="push-menu-item"
								onclick={openNewBranchDialog}
							>
								<GitBranch size={12} class="push-menu-item-icon" />
								<div class="push-menu-item-body">
									<span class="push-menu-item-title">Push to new branch…</span>
									<span class="push-menu-item-hint">
										Don't change the PR — push the agent's commits to a new ref.
									</span>
								</div>
							</button>
						</PopoverContent>
					</PopoverRoot>
				</div>
			{/if}
			{#if items.length > 0}
				<button
					class="icon-btn"
					onclick={handleClear}
					title="Clear conversation"
					aria-label="Clear conversation"
					disabled={isPushing || isResolving}
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
							<!-- role="button" instead of <button> so the Copy <button>
								 inside doesn't end up as a nested <button> (invalid
								 HTML — browsers reparent the inner button). Native
								 keyboard activation is restored via Enter/Space. -->
							<div
								class="proposed-row"
								role="button"
								tabindex="0"
								title="View diff"
								onclick={() => void openDiff(commit)}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										void openDiff(commit);
									}
								}}
							>
								<code class="proposed-sha">{commit.shortSha}</code>
								<span class="proposed-subject" title={commit.subject}>
									{commit.subject}
								</span>
							<button
								class="proposed-icon-btn"
								type="button"
								title="Copy SHA"
								aria-label="Copy SHA"
								onclick={(e) => {
									e.stopPropagation();
									copyToClipboard(commit.sha);
								}}
							>
								<Copy size={11} />
							</button>
							<button
								class="proposed-icon-btn proposed-icon-btn--danger"
								type="button"
								title="Discard commit"
								aria-label="Discard commit"
								disabled={isDiscardingCommit(commit.sha)}
								onclick={(e) => {
									e.stopPropagation();
									if (prId) void discardProposedCommitAction(prId, commit.sha);
								}}
							>
								{#if isDiscardingCommit(commit.sha)}
									<Loader2 size={11} class="motion-essential-spin" />
								{:else}
									<Trash2 size={11} />
								{/if}
							</button>
							<button
								class="proposed-icon-btn proposed-icon-btn--accent"
								type="button"
								title="Push this commit to PR branch"
								aria-label="Push this commit to PR branch"
								disabled={isCherryPickingCommit(commit.sha)}
								onclick={(e) => {
									e.stopPropagation();
									if (prId) void cherryPickProposedCommitAction(prId, commit.sha);
								}}
							>
								{#if isCherryPickingCommit(commit.sha)}
									<Loader2 size={11} class="motion-essential-spin" />
								{:else}
									<GitMerge size={11} />
								{/if}
							</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<!-- Blocked-by-unpushed-commits strip -->
	{#if blocked}
		<div class="blocked-strip">
			<div class="blocked-header">
				<AlertTriangle size={12} class="blocked-icon" />
				<span class="blocked-title">
					PR head advanced — {blocked.commits.length} unpushed commit{blocked.commits.length === 1 ? '' : 's'}
				</span>
				<button
					class="blocked-rebase-btn"
					type="button"
					onclick={() => prId && rebaseAllProposedAction(prId)}
					disabled={isRebasing}
					title="Rebase all commits onto new PR head"
				>
					{#if isRebasing}
						<Loader2 size={11} class="motion-essential-spin" />
						<span>Rebasing…</span>
					{:else}
						<RefreshCw size={11} />
						<span>Rebase all</span>
					{/if}
				</button>
			</div>
			<ul class="blocked-list">
				{#each blocked.commits as commit (commit.sha)}
					<li class="blocked-item">
						<code class="blocked-sha">{commit.shortSha}</code>
						<span class="blocked-subject" title={commit.subject}>{commit.subject}</span>
						<button
							class="blocked-discard-btn"
							type="button"
							onclick={() => prId && discardProposedCommitAction(prId, commit.sha)}
							disabled={isDiscardingCommit(commit.sha) || isRebasing}
							title="Discard this commit"
							aria-label="Discard commit {commit.shortSha}"
						>
							{#if isDiscardingCommit(commit.sha)}
								<Loader2 size={10} class="motion-essential-spin" />
							{:else}
								<Trash2 size={10} />
							{/if}
						</button>
					</li>
				{/each}
			</ul>
			<p class="blocked-hint">Rebase or discard all commits to continue chatting with the updated PR.</p>
		</div>
	{/if}

	<!-- Messages -->
	<div class="panel-content" bind:this={messagesEl} onscroll={handleScroll}>
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
				{#if item.kind === 'activity'}
						{#if !(item.turnId && streamingTurnIds.has(item.turnId))}
							<li class="tool-line">
								<span class="tool-bullet">›</span>
								<span class="tool-text">{item.summary}</span>
							</li>
						{/if}
					{:else if item.role === 'user'}
						<li class="msg msg--user">
							<div class="bubble bubble--user">{@html messageHtml(item.content)}</div>
						</li>
					{:else if item.kind === 'message' && item.role === 'assistant'}
					<li class="msg msg--assistant">
						<div class="bubble bubble--assistant">
								{#if item.content}
									{@html messageHtml(item.content)}
								{/if}
							{#if item.error}
								<div class="inline-error" role="alert">
									<AlertTriangle size={12} class="inline-error-icon" />
									<span class="inline-error-text">{item.error}</span>
								</div>
							{/if}
						</div>
					</li>
					{/if}
				{/each}
			</ul>
		{/if}

		{#if isStreaming}
			<div class="streaming-indicator" aria-label="AI is thinking…">
				{#if streamingTurnId}
					<Dotmatrix
						variant={squareVariantForId(streamingTurnId)}
						size="small"
					/>
				{/if}
				{#if recentToolCalls.length > 0}
					<div class="chat-tool-calls">
						{#each recentToolCalls as step, i (step.id)}
							<div
								class="chat-tool-call"
								style="top: {i * TOOL_CALL_ROW_H}px"
								in:fly={{ y: TOOL_CALL_ROW_H, duration: 220, easing: cubicOut }}
								out:fly={{ y: -TOOL_CALL_ROW_H, duration: 160, easing: cubicIn }}
							>
								<span class="chat-tool-call-tool">{step.toolName}</span>
								<span class="chat-tool-call-desc">{step.summary}</span>
							</div>
						{/each}
					</div>
				{:else}
					<StreamingVerb />
				{/if}
			</div>
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
		<div class="composer" class:composer--disabled={!prId}>
			<textarea
				bind:this={textareaEl}
				bind:value={inputValue}
				class="input-textarea"
				placeholder="Ask anything…"
				rows="1"
				onkeydown={handleKeydown}
				disabled={!prId}
			></textarea>
			<div class="composer-actions">
				{#if isStreaming}
					<button
						type="button"
						class="composer-btn composer-btn--stop"
						onclick={handleStop}
						aria-label="Stop generation"
						title="Stop generation"
					>
						<Square size={10} fill="currentColor" />
					</button>
				{:else}
					<button
						class="composer-btn composer-btn--send"
						type="submit"
						disabled={!prId || inputValue.trim().length === 0}
						aria-label="Send message"
						title="Send message"
					>
						<Send size={12} />
					</button>
				{/if}
			</div>
		</div>
	</form>
</div>

<!-- Conflict dialog (shown after a push attempt finds conflicts) -->
{#if conflictDialog}
	<div
		class="diff-overlay"
		role="dialog"
		aria-modal="true"
		aria-label="Push conflicts"
	>
		<button
			type="button"
			class="diff-overlay-backdrop"
			aria-label="Close conflict dialog"
			onclick={dismissConflictDialog}
		></button>
		<div class="conflict-card" role="document">
			<div class="conflict-card-header">
				<AlertTriangle size={14} class="conflict-card-icon" />
				<span class="conflict-card-title">Push conflicts</span>
				<button
					class="icon-btn"
					onclick={dismissConflictDialog}
					aria-label="Close conflict dialog"
				>
					<X size={14} />
				</button>
			</div>
			<div class="conflict-card-body">
				<p class="conflict-card-summary">
					The PR branch <code>{conflictDialog.branch}</code> has changed since the agent started, and merging the agent's commits would conflict in:
				</p>
				<ul class="conflict-file-list">
					{#each conflictDialog.files as file (file)}
						<li><code>{file}</code></li>
					{/each}
				</ul>
				<p class="conflict-card-hint">
					Want the agent to attempt resolving these conflicts? It will edit the affected files in the worktree, run <code>git merge --continue</code>, then push.
				</p>
			</div>
			<div class="conflict-card-footer">
				<button
					type="button"
					class="conflict-btn conflict-btn--secondary"
					onclick={dismissConflictDialog}
				>
					Cancel
				</button>
				<button
					type="button"
					class="conflict-btn conflict-btn--primary"
					onclick={handleResolveAndPush}
				>
					Let agent resolve
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- New-branch push dialog: `input` mode collects the branch name; once the
	 server reports the ref already exists we flip to `confirm-overwrite`
	 inside the same Dialog and require an explicit confirmation before
	 force-pushing. -->
<Dialog.Root bind:open={newBranchDialogOpen}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="new-branch-dialog-content">
			<Dialog.Header>
				<Dialog.Title>
					<span class="new-branch-title">
						{#if newBranchDialogMode === 'input'}
							<GitBranch size={16} />
							Push to a new branch
						{:else}
							<AlertTriangle size={16} class="new-branch-title-warn" />
							Branch already exists
						{/if}
					</span>
				</Dialog.Title>
				<Dialog.Description>
					{#if newBranchDialogMode === 'input'}
						Push the agent's commits to a brand-new branch on the remote. The
						current PR is not modified.
					{:else}
						<code>{newBranchValue}</code> already exists on the remote.
						Overwrite it with the agent's commits?
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			{#if newBranchDialogMode === 'input'}
				<label class="new-branch-field">
					<span class="new-branch-label">Branch name</span>
					<Input
						bind:ref={newBranchInputEl}
						type="text"
						autocomplete="off"
						spellcheck={false}
						bind:value={newBranchValue}
						placeholder={suggestedNewBranchName()}
						disabled={isPushing}
						class="font-mono"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter' && isValidNewBranchName(newBranchValue)) {
								e.preventDefault();
								void handleNewBranchSubmit();
							}
						}}
					/>
				</label>
				{#if newBranchValue.length > 0 && !isValidNewBranchName(newBranchValue)}
					<p class="new-branch-hint new-branch-hint--error">
						Branch names can't be empty, contain spaces, start with
						<code>-</code>, or contain <code>..</code>.
					</p>
				{:else}
					<p class="new-branch-hint">
						The branch will start at the PR's head SHA plus the
						{commitCount} agent commit{commitCount === 1 ? '' : 's'}.
					</p>
				{/if}
			{:else}
				<p class="new-branch-hint">
					This force-pushes the new branch and will discard any commits on the
					existing remote ref.
				</p>
			{/if}

			<Dialog.Footer>
				<Button
					variant="outline"
					size="sm"
					onclick={() => (newBranchDialogOpen = false)}
					disabled={isPushing}
				>
					Cancel
				</Button>
				{#if newBranchDialogMode === 'input'}
					<Button
						variant="default"
						size="sm"
						onclick={handleNewBranchSubmit}
						disabled={isPushing || !isValidNewBranchName(newBranchValue)}
					>
						{#if isPushing}
							<Loader2 size={12} class="motion-essential-spin" />
							Pushing…
						{:else}
							Push
						{/if}
					</Button>
				{:else}
					<Button
						variant="destructive"
						size="sm"
						onclick={handleConfirmOverwrite}
						disabled={isPushing}
					>
						{#if isPushing}
							<Loader2 size={12} class="motion-essential-spin" />
							Overwriting…
						{:else}
							Overwrite
						{/if}
					</Button>
				{/if}
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<!-- Diff overlay (Pierre-rendered, portaled to body so it centres on the
	 viewport — the right panel's parent has a transform that would
	 otherwise scope `position: fixed` to the panel rather than the screen). -->
{#if diffOpen && prId}
	<ProposedDiffModal
		prId={prId}
		sha={diffOpen.sha}
		subject={diffOpen.subject}
		body={diffOpen.body}
		onClose={() => (diffOpen = null)}
	/>
{/if}

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (diffOpen) diffOpen = null;
			else if (conflictDialog) conflictDialog = null;
			// `newBranchDialogOpen` is handled by the shadcn Dialog primitive.
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

	/* Streaming indicator — dot matrix + last-2 tool calls sit below the
	   last message during a streaming turn. */
	.streaming-indicator {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 10px 14px;
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

	.icon-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* Split-pill push button. Two clickable regions joined by a thin
	   divider — the wider left half pushes to the PR branch (default),
	   the narrower right half opens a popover with alternative targets.
	   The pulse animation on success runs on the wrapper so both halves
	   share it.

	   Style: a neutral elevated chip. The accent comes through only in
	   the upload icon + count badge so the button reads as primary
	   without flooding the panel header with color. Both halves are
	   transparent and inherit the wrapper background, so the surface
	   is uniform across the divider. */
	.push-pill {
		display: inline-flex;
		align-items: stretch;
		height: 24px;
		border-radius: 6px;
		overflow: hidden;
		background: transparent;
		color: var(--color-text-primary);
		border: 1px solid color-mix(in srgb, var(--color-text-muted) 55%, transparent);
		transition: background-color var(--duration-snap), border-color var(--duration-snap);
	}

	.push-pill:hover:not(:has(button:disabled)) {
		background: var(--color-bg-tertiary);
		border-color: var(--color-text-muted);
	}

	.push-pill-main,
	.push-pill-chevron {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	/* Click feedback only — hover lives on the wrapper and applies to
	   the whole pill uniformly. The :active darken gives a momentary
	   "press" cue on whichever half was actually clicked, without
	   creating a persistent half-vs-half tint mismatch. */
	.push-pill-main:active:not(:disabled),
	.push-pill-chevron:active:not(:disabled) {
		background: rgba(0, 0, 0, 0.08);
	}

	.push-pill-main {
		gap: 6px;
		padding: 0 9px;
		font-size: 12px;
		font-weight: 500;
		letter-spacing: 0.01em;
	}

	/* Upload / Loader icon picks up the accent — that's where the color
	   actually lives. */
	.push-pill-main :global(svg) {
		color: var(--color-accent);
	}

	.push-pill-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		line-height: 1;
		color: var(--color-text-primary);
	}

	.push-pill-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 16px;
		height: 16px;
		padding: 0 5px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-accent) 22%, transparent);
		color: var(--color-accent);
		font-size: 10px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.push-pill-chevron {
		width: 18px;
		padding: 0;
		border-left: 1px solid color-mix(in srgb, var(--color-text-muted) 55%, transparent);
		color: var(--color-text-muted);
	}

	.push-pill-main:disabled,
	.push-pill-chevron:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Items inside the shadcn Popover surface; the surface itself comes
	   styled by PopoverContent (we just pass `w-72 p-1`). The inner radius
	   is the outer (rounded-xl = 12px) minus the wrapper padding (p-1 = 4px)
	   so the hover background's corners stay concentric with the popover. */
	.push-menu-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		background: transparent;
		border: none;
		border-radius: 8px;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-snap);
	}

	.push-menu-item:hover {
		background: var(--color-bg-tertiary);
	}

	:global(.push-menu-item-icon) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--color-accent);
	}

	.push-menu-item-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.push-menu-item-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.push-menu-item-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	/* The Loader2 icon needs to spin during a push. The .motion-essential-*
	   pattern opts back into animation under prefers-reduced-motion (per
	   project convention) so users with reduced-motion still see the
	   loading affordance. Without this they'd see a static icon and have
	   no signal that a push is in flight. */
	:global(.motion-essential-spin) {
		animation: motion-essential-spin 1s linear infinite;
	}

	@keyframes motion-essential-spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
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
		padding: 2px 4px;
		margin: 0 -4px;
		border-radius: 4px;
		cursor: pointer;
		transition: background-color var(--duration-snap);
	}

	.proposed-row:hover {
		background: var(--color-bg-tertiary);
	}

	.proposed-row:focus-visible {
		outline: none;
		background: var(--color-bg-tertiary);
		box-shadow: 0 0 0 1px var(--color-accent);
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

	.proposed-icon-btn--danger:hover:not(:disabled) {
		color: var(--color-destructive, hsl(0 72% 51%));
		background: color-mix(in srgb, var(--color-destructive, hsl(0 72% 51%)) 12%, transparent);
	}

	.proposed-icon-btn--accent:hover:not(:disabled) {
		color: var(--color-primary);
		background: color-mix(in srgb, var(--color-primary) 12%, transparent);
	}

	/* Blocked-by-unpushed-commits strip */
	.blocked-strip {
		flex-shrink: 0;
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 8%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 25%, transparent);
		padding: 8px 12px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.blocked-header {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	:global(.blocked-icon) {
		color: var(--color-warning, #f59e0b);
		flex-shrink: 0;
	}

	.blocked-title {
		font-size: 12px;
		font-weight: 500;
		flex: 1;
		min-width: 0;
	}

	.blocked-rebase-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		padding: 3px 8px;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		cursor: pointer;
		color: var(--color-text-secondary);
		flex-shrink: 0;
		transition: background-color var(--duration-snap);
	}

	.blocked-rebase-btn:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.blocked-rebase-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.blocked-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.blocked-item {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
	}

	.blocked-sha {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.blocked-subject {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.blocked-discard-btn {
		flex-shrink: 0;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		border: none;
		background: transparent;
		cursor: pointer;
		color: var(--color-text-muted);
		padding: 0;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.blocked-discard-btn:hover:not(:disabled) {
		color: var(--color-danger, #ef4444);
		background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
	}

	.blocked-discard-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.blocked-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		margin: 0;
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
		padding: 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.msg {
		display: flex;
	}

	.msg--user {
		justify-content: flex-end;
	}

	.msg--assistant {
		align-items: flex-start;
		gap: 8px;
	}

	/* Shared bubble base */
	.bubble {
		font-size: 13px;
		line-height: 1.55;
		word-wrap: break-word;
	}

	/* User bubble — right-aligned, accent background */
	.bubble--user {
		background: var(--color-accent);
		color: #fff;
		border-radius: 14px 14px 4px 14px;
		padding: 8px 12px;
		max-width: 82%;
	}

	/* Inline markdown styling inside the accent-tinted user bubble.
	   The defaults from `renderMarkdown` lean on the assistant palette
	   (muted tertiary backgrounds) which is invisible on accent. These
	   overrides keep code/links/quotes legible on top of the bubble. */
	.bubble--user :global(p) { margin: 4px 0; }
	.bubble--user :global(p:first-child) { margin-top: 0; }
	.bubble--user :global(p:last-child) { margin-bottom: 0; }
	.bubble--user :global(ul),
	.bubble--user :global(ol) { margin: 4px 0; padding-left: 18px; }
	.bubble--user :global(li) { margin: 2px 0; }
	.bubble--user :global(strong) { font-weight: 600; }
	.bubble--user :global(em) { font-style: italic; }
	.bubble--user :global(a) {
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.bubble--user :global(code) {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: rgba(0, 0, 0, 0.22);
		border-radius: 3px;
		padding: 1px 4px;
	}
	.bubble--user :global(pre) {
		margin: 6px 0;
		padding: 8px 10px;
		background: rgba(0, 0, 0, 0.22);
		border-radius: 4px;
		overflow-x: auto;
	}
	.bubble--user :global(pre code) {
		background: none;
		padding: 0;
		font-size: 11px;
		line-height: 1.5;
	}
	.bubble--user :global(blockquote) {
		border-left: 2px solid rgba(255, 255, 255, 0.55);
		margin: 6px 0;
		padding: 2px 10px;
		color: rgba(255, 255, 255, 0.85);
	}

	/* Agent avatar dot — removed; avatar div is no longer rendered */

	/* Assistant — no bubble, plain content next to the avatar */
	.bubble--assistant {
		flex: 1;
		min-width: 0;
		color: var(--color-text-primary);
		padding-top: 2px;
	}

	.bubble--assistant :global(h2) {
		font-size: 14px;
		font-weight: 600;
		margin: 12px 0 4px;
	}
	.bubble--assistant :global(h3) {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
		margin: 10px 0 4px;
	}
	.bubble--assistant :global(p) { margin: 4px 0; }
	.bubble--assistant :global(ul),
	.bubble--assistant :global(ol) { margin: 4px 0; padding-left: 18px; }
	.bubble--assistant :global(li) { margin: 2px 0; }
	.bubble--assistant :global(strong) { font-weight: 600; }
	.bubble--assistant :global(code) {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
	}
	.bubble--assistant :global(pre) {
		margin: 6px 0;
		padding: 8px 10px;
		background: var(--color-diff-bg);
		border-radius: 4px;
		overflow-x: auto;
	}
	.bubble--assistant :global(pre code) {
		background: none;
		padding: 0;
		font-size: 11px;
		line-height: 1.5;
	}
	.bubble--assistant :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.bubble--assistant :global(blockquote) {
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

	/* Streaming tool-call stack: shown in the panel header during a
	   streaming turn (next to the dot-matrix loader). Last 2 activities
	   stack vertically and animate up as new ones arrive — same shape as
	   the walkthrough's tool-call rows. */
	.chat-tool-calls {
		position: relative;
		flex: 1;
		height: 28px; /* 2 × 14px rows — fixed to prevent layout shift */
		min-width: 0;
		overflow: hidden;
	}

	.chat-tool-call {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		gap: 6px;
		min-width: 0;
		font-size: 10px;
		line-height: 14px;
		transition: top 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
	}

	.chat-tool-call-tool {
		color: var(--color-accent);
		font-weight: 500;
		flex-shrink: 0;
	}

	.chat-tool-call-desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		color: var(--color-text-muted);
	}

	/* Inline error chip — attached to an assistant bubble whose stream
	   errored mid-turn. Distinct from the panel-level error-state block,
	   which renders only when there's no bubble to attach to. */
	.inline-error {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin-top: 8px;
		padding: 6px 8px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		border-left: 2px solid var(--color-text-muted);
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	:global(.inline-error-icon) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.inline-error-text {
		word-wrap: break-word;
		min-width: 0;
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

	/* Input row — outer form is now just a layout/padding wrapper. The
	   visible "input" is the .composer surface inside, which unifies the
	   textarea and the send/stop button into a single bordered chip with
	   a shared focus-within ring. */
	.input-row {
		display: flex;
		padding: 10px 10px 12px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-panel-bg);
		flex-shrink: 0;
	}

	.composer {
		position: relative;
		flex: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 6px 6px 14px;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border-subtle);
		border-radius: 999px;
		box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
		transition:
			border-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo);
	}

	.composer:hover:not(.composer--disabled):not(:focus-within) {
		border-color: var(--color-border);
	}

	.composer:focus-within {
		border-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent),
			0 1px 0 rgba(0, 0, 0, 0.04);
	}

	.composer--disabled {
		opacity: 0.6;
	}

	.input-textarea {
		flex: 1;
		min-width: 0;
		min-height: 22px;
		max-height: 96px;
		padding: 6px 0;
		font-size: 13px;
		line-height: 1.45;
		font-family: inherit;
		color: var(--color-text-primary);
		background: transparent;
		border: none;
		border-radius: 0;
		resize: none;
		outline: none;
	}

	.input-textarea::placeholder {
		color: var(--color-text-muted);
	}

	.input-textarea:disabled {
		cursor: not-allowed;
	}

	.composer-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.composer-btn {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap),
			opacity var(--duration-snap),
			transform var(--duration-snap);
	}

	.composer-btn:active:not(:disabled) {
		transform: scale(0.94);
	}

	.composer-btn--send {
		background: var(--color-accent);
		color: #fff;
	}

	.composer-btn--send:hover:not(:disabled) {
		background: var(--color-accent-hover);
	}

	.composer-btn--send:disabled {
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
		cursor: not-allowed;
	}

	.composer-btn--stop {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border-subtle);
	}

	.composer-btn--stop:hover {
		background: var(--color-bg-primary);
		color: var(--color-text-primary);
		border-color: var(--color-border);
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

	/* Conflict dialog */
	.conflict-card {
		position: relative;
		max-width: min(520px, 90vw);
		max-height: 80vh;
		background: var(--color-panel-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.conflict-card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
	}

	:global(.conflict-card-icon) {
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.conflict-card-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
		flex: 1;
		min-width: 0;
	}

	.conflict-card-body {
		padding: 14px 16px;
		font-size: 12px;
		line-height: 1.55;
		color: var(--color-text-secondary);
		overflow-y: auto;
	}

	.conflict-card-summary,
	.conflict-card-hint {
		margin: 0 0 10px;
	}

	.conflict-card-hint {
		margin: 12px 0 0;
		color: var(--color-text-muted);
	}

	.conflict-card-summary code,
	.conflict-card-hint code {
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
		color: var(--color-text-primary);
	}

	.conflict-file-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 180px;
		overflow-y: auto;
	}

	.conflict-file-list li {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 4px 6px;
	}

	.conflict-card-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 12px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
	}

	.conflict-btn {
		font-size: 12px;
		padding: 5px 12px;
		border-radius: 5px;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			border-color var(--duration-snap);
	}

	.conflict-btn--secondary {
		background: transparent;
		color: var(--color-text-secondary);
		border-color: var(--color-border-subtle);
	}

	.conflict-btn--secondary:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.conflict-btn--primary {
		background: var(--color-accent);
		color: var(--color-bg-primary);
		font-weight: 500;
	}

	.conflict-btn--primary:hover {
		opacity: 0.9;
	}

	/* New-branch dialog (shadcn Dialog content). The shadcn Input
	   handles its own styling; we add label/hint typography and the
	   title-with-icon shell. */
	:global(.new-branch-dialog-content) {
		max-width: 440px !important;
		width: 100%;
	}

	.new-branch-title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	:global(.new-branch-title-warn) {
		color: var(--color-warning, #d97706);
	}

	.new-branch-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 4px;
	}

	.new-branch-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.new-branch-hint {
		margin: 0;
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	.new-branch-hint--error {
		color: var(--color-danger, #d93b3b);
	}

	.new-branch-hint code {
		font-family: var(--font-mono);
		font-size: 10.5px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
	}
</style>
