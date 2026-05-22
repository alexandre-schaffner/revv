<script lang="ts">
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FileEdit,
  Gauge,
  GitMerge,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  XCircle,
} from "@lucide/svelte";
import { page } from "$app/state";
import { Shimmer } from "$lib/components/ai/shimmer";
import SettingsModal from "$lib/components/settings/SettingsModal.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
import { RAIL_WIDTH } from "$lib/constants";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import {
  closePr,
  convertPrToDraft,
  getMergeEligibility,
  getSelectedPr,
  markPrReadyForReview,
  mergePr,
} from "$lib/stores/prs.svelte";
import {
  getRcApproveBlockerSummary,
  getRcHasContent,
  getRcOnApprove,
  getRcOnGenerateChanges,
  getRcOnSubmitReview,
  getRcSelectedCount,
  getRcSubmitting,
} from "$lib/stores/rcActions.svelte";
import {
  consumePanelOpenRequest,
  getActiveTab,
  getIsPullingCommit,
  getLoadedHeadSha,
  getPanelOpenRequested,
  pullLatestCommit,
  setActiveTab,
} from "$lib/stores/review.svelte";
import { closeSettings, getSettingsOpen } from "$lib/stores/settingsModal.svelte";
import { closePalette, getPaletteMode, getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getRightPanelOpen,
  getRightPanelWidth,
  getSidebarCollapsed,
  getSidebarPeekHovering,
  getSidebarWidth,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  resetRightPanelWidth,
  resetSidebarWidth,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  setRightPanelOpen,
  setRightPanelWidth,
  setSidebarWidth,
  toggleRightPanel,
  toggleSidebar,
} from "$lib/stores/sidebar.svelte";
import {
  getPrWalkthroughStatus,
  getRatings as getWalkthroughRatings,
} from "$lib/stores/walkthrough.svelte";
import {
  abort as abortWalkthrough,
  getPendingAction as getWalkthroughPendingAction,
  regenerate as regenerateWalkthrough,
  resume as resumeWalkthrough,
} from "$lib/stores/walkthrough-stream.svelte";
import { getWalkthroughUiState } from "$lib/stores/walkthrough-ui-state.svelte";
import {
  getHasNewContentBelow as getWalkthroughHasNewContentBelow,
  scrollToBottom as scrollWalkthroughToBottom,
  scrollToRatings as scrollWalkthroughToRatings,
  scrollToTop as scrollWalkthroughToTop,
} from "$lib/stores/walkthroughNav.svelte";
import BottomBar from "./BottomBar.svelte";
import CommandPalette from "./CommandPalette.svelte";
import FloatingTabs from "./FloatingTabs.svelte";
import ProjectRail from "./ProjectRail.svelte";
import RightPanel from "./RightPanel.svelte";
import Sidebar from "./Sidebar.svelte";
import TopBar from "./TopBar.svelte";

let { children } = $props();

const sidebarCollapsed = $derived(getSidebarCollapsed());
// Effective collapsed state: false when the user is hovering a project
// avatar (or the sidebar itself) so the column expands as a peek without
// flipping the persistent toggle. Used for layout (grid columns, floating
// action bar alignment, Sidebar contents). The TopBar toggle and the
// resize handle stay bound to the real `sidebarCollapsed` so peek is
// purely visual and never repositions controls.
const sidebarPeekHovering = $derived(getSidebarPeekHovering());
const sidebarEffectiveCollapsed = $derived(sidebarCollapsed && !sidebarPeekHovering);
const rightPanelOpen = $derived(getRightPanelOpen());
const paletteOpen = $derived(getPaletteOpen());
const paletteMode = $derived(getPaletteMode());
const sidebarWidth = $derived(getSidebarWidth());
const rightPanelWidth = $derived(getRightPanelWidth());
const pr = $derived(getSelectedPr());
const walkthroughStatus = $derived(pr ? getPrWalkthroughStatus(pr.id) : "idle");
const activeTab = $derived(getActiveTab());
const isSettingsRoute = $derived(page.url.pathname.startsWith("/settings"));
const isReviewRoute = $derived(page.url.pathname.startsWith("/review/"));
const walkthroughUiState = $derived(getWalkthroughUiState());
const walkthroughPendingAction = $derived(pr ? getWalkthroughPendingAction(pr.id) : null);
const walkthroughHasRatings = $derived(getWalkthroughRatings().length > 0);
const walkthroughHasNewContentBelow = $derived(getWalkthroughHasNewContentBelow());
// Bar is hidden in absent/idle/cloning — those are handled by GuidedWalkthrough's
// inline UI (empty state, clone-in-progress skeleton). The bar only carries
// post-start actions: stop, resume, retry, regenerate, navigation.
const walkthroughBarHasActions = $derived(
  walkthroughUiState.kind !== "absent" &&
    walkthroughUiState.kind !== "idle" &&
    walkthroughUiState.kind !== "cloning",
);
const showFloatingActions = $derived(
  !!pr &&
    isReviewRoute &&
    !isSettingsRoute &&
    activeTab === "walkthrough" &&
    walkthroughBarHasActions,
);
const showRcActions = $derived(
  !!pr && isReviewRoute && !isSettingsRoute && activeTab === "request-changes",
);

const rcSubmitting = $derived(getRcSubmitting());
const rcSelectedCount = $derived(getRcSelectedCount());
const rcHasContent = $derived(getRcHasContent());
const rcApproveBlockerSummary = $derived(getRcApproveBlockerSummary());
const chatStreaming = $derived(pr ? isChatStreaming(pr.id) : false);

let rcGenerating = $state(false);

$effect(() => {
  if (!chatStreaming) rcGenerating = false;
});

// The reviewer-vs-coder distinction comes from the user's GitHub login
// matching the PR's authorLogin. When the user owns the PR, the
// approve / request-changes pair is replaced by owner-only mutations:
// toggle draft state, and close the PR. Generate Changes still applies
// (the agent can write code regardless of authorship), so we leave it.
const currentUserLogin = $derived(getCurrentUserLogin());
const isPrOwner = $derived(!!pr && pr.authorLogin === currentUserLogin);

type OwnerAction = "convert-to-draft" | "ready-for-review" | "close";
let ownerSubmitting = $state<OwnerAction | null>(null);

async function runOwnerAction(action: OwnerAction): Promise<void> {
  if (!pr || ownerSubmitting !== null) return;
  ownerSubmitting = action;
  try {
    if (action === "convert-to-draft") await convertPrToDraft(pr.id);
    else if (action === "ready-for-review") await markPrReadyForReview(pr.id);
    else await closePr(pr.id);
  } finally {
    ownerSubmitting = null;
  }
}

let mergeEligibility = $state<import("@revv/shared").MergeEligibility | null>(null);
let mergeSubmitting = $state<string | null>(null);
let mergeMenuOpen = $state(false);

$effect(() => {
  const prId = pr?.id;
  const owner = isPrOwner;
  if (!prId || !owner) {
    mergeEligibility = null;
    return;
  }
  getMergeEligibility(prId).then((el) => {
    mergeEligibility = el;
  });
});

async function runMerge(method: import("@revv/shared").MergeMethod): Promise<void> {
  if (!pr || mergeSubmitting !== null) return;
  mergeSubmitting = method;
  mergeMenuOpen = false;
  try {
    await mergePr(pr.id, method);
  } finally {
    mergeSubmitting = null;
  }
}

// New-commit-available signal: the PR's current headSha differs from the
// SHA the diff was loaded against. `getLoadedHeadSha` returns null until the
// first successful fetch, suppressing the signal on fresh visits.
const hasNewCommit = $derived.by(() => {
  if (!pr?.headSha) return false;
  const loaded = getLoadedHeadSha(pr.id);
  return loaded !== null && loaded !== pr.headSha;
});
const isPulling = $derived(pr ? getIsPullingCommit(pr.id) : false);
function onPullCommit(): void {
  if (pr) void pullLatestCommit(pr.id);
}

// Drag state — not reactive $state, just local mutable refs
let isDragging = $state(false);
let dragStartX = 0;
let dragStartWidth = 0;

// Right-pane drag state — separate from sidebar so a drag on one handle
// can't be confused with the other and the resize-suppression class
// applies independently.
let isResizingRight = $state(false);
let rightDragStartX = 0;
let rightDragStartWidth = 0;

// Auto-open panel when explain is triggered from the review store
$effect(() => {
  if (getPanelOpenRequested()) {
    setRightPanelOpen(true);
    consumePanelOpenRequest();
  }
});

// Close the chat panel when navigating away from a PR page
$effect(() => {
  if (!pr && rightPanelOpen) {
    setRightPanelOpen(false);
  }
});

// Inline style for the grid — drives the dynamic sidebar AND right-panel
// column widths. The right pane is a real grid column whose width
// collapses to 0 when closed; opening it shrinks the main column rather
// than overlaying on top of it. Animation comes from the
// grid-template-columns transition on .app-shell.
const gridStyle = $derived(
  `grid-template-columns: ${RAIL_WIDTH}px ${sidebarEffectiveCollapsed ? "0" : `${sidebarWidth}px`} 1fr ${rightPanelOpen ? `${rightPanelWidth}px` : "0"}`,
);

function onHandlePointerDown(event: PointerEvent): void {
  if (sidebarCollapsed) return;
  event.preventDefault();
  isDragging = true;
  dragStartX = event.clientX;
  dragStartWidth = sidebarWidth;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onHandlePointerMove(event: PointerEvent): void {
  if (!isDragging) return;
  const delta = event.clientX - dragStartX;
  const newWidth = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, dragStartWidth + delta));
  setSidebarWidth(newWidth);
}

function onHandlePointerUp(event: PointerEvent): void {
  if (!isDragging) return;
  isDragging = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

function onHandleDblClick(): void {
  resetSidebarWidth();
}

function onRightHandlePointerDown(event: PointerEvent): void {
  if (!rightPanelOpen) return;
  event.preventDefault();
  isResizingRight = true;
  rightDragStartX = event.clientX;
  rightDragStartWidth = rightPanelWidth;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onRightHandlePointerMove(event: PointerEvent): void {
  if (!isResizingRight) return;
  // Dragging left grows the panel, dragging right shrinks it — invert delta.
  const delta = rightDragStartX - event.clientX;
  const newWidth = Math.max(
    RIGHT_PANEL_WIDTH_MIN,
    Math.min(RIGHT_PANEL_WIDTH_MAX, rightDragStartWidth + delta),
  );
  setRightPanelWidth(newWidth);
}

function onRightHandlePointerUp(event: PointerEvent): void {
  if (!isResizingRight) return;
  isResizingRight = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

function onRightHandleDblClick(): void {
  resetRightPanelWidth();
}
</script>

<div
	class="app-shell"
	class:sidebar-collapsed={sidebarEffectiveCollapsed}
	class:is-resizing={isDragging || isResizingRight}
	style={gridStyle}
>
	<aside class="rail-area">
		<ProjectRail />
	</aside>

	<aside class="sidebar-area">
		<Sidebar collapsed={sidebarEffectiveCollapsed} />

		{#if !sidebarCollapsed}
			<div
				class="resize-handle"
				role="separator"
				aria-label="Resize sidebar"
				aria-orientation="vertical"
				tabindex="-1"
				onpointerdown={onHandlePointerDown}
				onpointermove={onHandlePointerMove}
				onpointerup={onHandlePointerUp}
				ondblclick={onHandleDblClick}
			></div>
		{/if}
	</aside>

	<header class="topbar-area" data-tauri-drag-region>
		<TopBar
			{rightPanelOpen}
			onTogglePanel={toggleRightPanel}
			{sidebarCollapsed}
			onToggleSidebar={toggleSidebar}
		/>
	</header>

	<main class="main-area">
		{#if pr && isReviewRoute && !isSettingsRoute}
			<div class="main-tab-bar">
				<FloatingTabs
					{activeTab}
					onTabChange={setActiveTab}
					{walkthroughStatus}
					{hasNewCommit}
					{isPulling}
					{onPullCommit}
				/>
			</div>
		{/if}
		<div class="main-content">
			{@render children()}
		</div>

		{#if showFloatingActions && activeTab === 'walkthrough' && pr}
		<!-- Floating actions for the walkthrough tab. Branches on a single
		     discriminated UiState (see walkthrough-ui-state.svelte.ts) so the
		     bar can't fall into two mutually-exclusive branches at once.
		     Destructive actions are disabled while a regenerate/resume is
		     in-flight or while a chat-edit stream is mutating the same
		     walkthrough — Stop intentionally stays enabled. -->
		{@const destructiveDisabled = walkthroughPendingAction !== null || chatStreaming}
		{@const destructiveTitle = chatStreaming
			? 'Chat edit in progress — wait for it to finish before regenerating'
			: walkthroughPendingAction === 'regenerate'
				? 'Regenerating…'
				: walkthroughPendingAction === 'resume'
					? 'Resuming…'
					: undefined}
		<div class="walkthrough-actions-float">
			<div class="walkthrough-actions-row">
				<GlassPill
					icon
					onclick={scrollWalkthroughToTop}
					aria-label="Scroll to top of walkthrough"
				>
					<ArrowUp size={14} />
				</GlassPill>

				{#if walkthroughUiState.kind === 'streaming'}
					<GlassPill
						variant="danger"
						onclick={() => abortWalkthrough(pr.id)}
					>
						<Square size={14} fill="currentColor" />
						Stop generation
					</GlassPill>
					{#if walkthroughHasNewContentBelow}
						<GlassPill
							onclick={scrollWalkthroughToBottom}
							aria-label="Scroll to newest walkthrough content"
						>
							<ArrowDown size={14} />
							New content
						</GlassPill>
					{/if}
				{:else if walkthroughUiState.kind === 'resumable'}
					<GlassPill
						disabled={destructiveDisabled}
						title={destructiveTitle}
						onclick={() => resumeWalkthrough(pr.id)}
						aria-label="Resume walkthrough from where it stopped"
					>
						<Play size={14} fill="currentColor" />
						Resume
					</GlassPill>
					<GlassPill
						disabled={destructiveDisabled}
						title={destructiveTitle}
						onclick={() => regenerateWalkthrough(pr.id)}
					>
						<RefreshCw size={14} />
						Regenerate
					</GlassPill>
				{:else if walkthroughUiState.kind === 'error-partial'}
					<GlassPill
						disabled={destructiveDisabled}
						title={destructiveTitle}
						onclick={() => resumeWalkthrough(pr.id)}
						aria-label="Retry walkthrough from where it failed"
					>
						<RotateCcw size={14} />
						Retry
					</GlassPill>
					<GlassPill
						disabled={destructiveDisabled}
						title={destructiveTitle}
						onclick={() => regenerateWalkthrough(pr.id)}
					>
						<RefreshCw size={14} />
						Regenerate
					</GlassPill>
				{:else if walkthroughUiState.kind === 'error-empty'}
					<GlassPill
						disabled={destructiveDisabled}
						title={destructiveTitle}
						onclick={() => regenerateWalkthrough(pr.id)}
						aria-label="Retry walkthrough generation after error"
					>
						<RefreshCw size={14} />
						Retry
					</GlassPill>
				{:else if walkthroughUiState.kind === 'complete'}
					<GlassPill
						disabled={destructiveDisabled}
						title={destructiveTitle}
						onclick={() => regenerateWalkthrough(pr.id)}
					>
						<RefreshCw size={14} />
						Regenerate
					</GlassPill>
				{:else if walkthroughUiState.kind === 'complete-stale'}
					<GlassPill
						variant="accent"
						disabled={destructiveDisabled}
						title={chatStreaming
							? 'Chat edit in progress — wait for it to finish before regenerating'
							: 'A newer commit landed — this walkthrough is for an older SHA. Regenerate against the latest.'}
						onclick={() => regenerateWalkthrough(pr.id)}
					>
						<RefreshCw size={14} />
						Regenerate for latest commit
					</GlassPill>
				{/if}

				{#if walkthroughHasRatings}
					<GlassPill
						onclick={scrollWalkthroughToRatings}
						aria-label="Scroll to rating panel"
					>
						<Gauge size={14} />
						Rating
					</GlassPill>
				{/if}
			</div>
		</div>
	{/if}

	{#if showRcActions && activeTab === 'request-changes'}
		<div class="walkthrough-actions-float">
			<div class="walkthrough-actions-row">
				<GlassPill
					variant="muted"
					disabled={rcSubmitting !== null || rcSelectedCount === 0 || rcGenerating}
					onclick={() => { rcGenerating = true; getRcOnGenerateChanges()(); }}
					title={rcSelectedCount === 0
						? 'Select at least one issue to ask the agent to address'
						: rcGenerating
							? 'Agent is generating changes…'
							: 'Open the chat panel and ask the agent to address the selected issues as commits'}
				>
					<Sparkles size={14} />
					<Shimmer active={rcSubmitting === null && rcSelectedCount > 0}>
						{rcGenerating ? 'Generating changes…' : 'Generate changes'}
					</Shimmer>
				</GlassPill>

				{#if isPrOwner && pr}
					<!-- Owner view — the reviewer's Approve / Request Changes pair
					     doesn't apply when you authored the PR, so we surface the
					     two actions a coder actually needs from this screen:
					     toggle draft state, and close the PR. -->
					{#if pr.isDraft}
						<GlassPill
							variant="accent"
							disabled={ownerSubmitting !== null}
							onclick={() => runOwnerAction('ready-for-review')}
							title="Mark this draft as ready for review"
						>
							<Send size={14} />
							{ownerSubmitting === 'ready-for-review' ? 'Marking ready…' : 'Ready for review'}
						</GlassPill>
					{:else}
						<GlassPill
							disabled={ownerSubmitting !== null}
							onclick={() => runOwnerAction('convert-to-draft')}
							title="Move this PR back to draft state"
						>
							<FileEdit size={14} />
							{ownerSubmitting === 'convert-to-draft' ? 'Converting…' : 'Convert to draft'}
						</GlassPill>
					{/if}

					{#if mergeEligibility?.canMerge && pr.status === 'open'}
						<div
							class="glass-pill glass-pill--success merge-pill"
							class:is-disabled={ownerSubmitting !== null || mergeSubmitting !== null}
						>
							<button
								type="button"
								class="merge-pill-main"
								disabled={ownerSubmitting !== null || mergeSubmitting !== null}
								onclick={() => runMerge('merge')}
								title="Merge this pull request"
							>
								<GitMerge size={14} />
								{mergeSubmitting === 'merge' ? 'Merging…' : 'Merge'}
							</button>
							<Popover bind:open={mergeMenuOpen}>
								<PopoverTrigger>
									<button
										type="button"
										class="merge-pill-chevron"
										disabled={ownerSubmitting !== null || mergeSubmitting !== null}
										aria-label="Merge options"
										title="Choose merge strategy"
									>
										<ChevronDown size={14} />
									</button>
								</PopoverTrigger>
								<PopoverContent class="w-56 p-1" align="end" side="top">
									<button
										type="button"
										class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
										onclick={() => runMerge('merge')}
									>
										<GitMerge size={12} />
										Create a merge commit
									</button>
									<button
										type="button"
										class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
										onclick={() => runMerge('squash')}
									>
										<GitMerge size={12} />
										Squash and merge
									</button>
									<button
										type="button"
										class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
										onclick={() => runMerge('rebase')}
									>
										<GitMerge size={12} />
										Rebase and merge
									</button>
								</PopoverContent>
							</Popover>
						</div>
					{/if}

					<GlassPill
						variant="danger"
						disabled={ownerSubmitting !== null}
						onclick={() => runOwnerAction('close')}
						title="Close this pull request without merging"
					>
						<XCircle size={14} />
						{ownerSubmitting === 'close' ? 'Closing…' : 'Close PR'}
					</GlassPill>
				{:else}
					<GlassPill
						variant="accent"
						disabled={rcSubmitting !== null || !rcHasContent}
						onclick={() => getRcOnSubmitReview()()}
						title={!rcHasContent
							? 'Add comments or select walkthrough issues first'
							: 'Request changes on this pull request'}
					>
						<ArrowUp size={14} />
						{rcSubmitting === 'request_changes' ? 'Submitting…' : 'Submit Review'}
					</GlassPill>
					<GlassPill
						variant="success"
						disabled={rcSubmitting !== null}
						onclick={() => getRcOnApprove()()}
						title={rcApproveBlockerSummary
							? `Approve this pull request — ${rcApproveBlockerSummary} still open`
							: 'Approve this pull request on GitHub'}
					>
						<Check size={14} />
						{rcSubmitting === 'approve' ? 'Approving…' : 'Approve'}
					</GlassPill>
				{/if}
			</div>
		</div>
	{/if}
	</main>

	<aside class="userbar-area">
		<UserMenu collapsed={sidebarEffectiveCollapsed} />
	</aside>

	<footer class="bottombar-area">
		<BottomBar />
	</footer>

	<aside
		class="rightpanel-area"
		class:rightpanel-area--open={rightPanelOpen}
		aria-hidden={!rightPanelOpen}
	>
		{#if rightPanelOpen}
			<div
				class="right-resize-handle"
				role="separator"
				aria-label="Resize right panel"
				aria-orientation="vertical"
				tabindex="-1"
				onpointerdown={onRightHandlePointerDown}
				onpointermove={onRightHandlePointerMove}
				onpointerup={onRightHandlePointerUp}
				ondblclick={onRightHandleDblClick}
			></div>
		{/if}
		<RightPanel onClose={toggleRightPanel} prId={page.params['prId'] ?? ''} />
	</aside>
</div>

<CommandPalette open={paletteOpen} mode={paletteMode} onClose={closePalette} />
<SettingsModal open={getSettingsOpen()} onClose={closeSettings} />

<style>
	.app-shell {
		display: grid;
		grid-template-rows: auto 1fr calc(var(--bottombar-height) + var(--spacing-island));
		grid-template-areas:
			'topbar  topbar  topbar    topbar'
			'rail    sidebar main      rightpanel'
			'userbar userbar bottombar bottombar';
		height: 100vh;
		width: 100vw;
		overflow: hidden;
		/* Positioning context for the absolutely-positioned right pane. */
		position: relative;
		background-color: var(--color-bg-secondary);
	transition:
		grid-template-columns var(--duration-smooth) var(--ease-out-expo),
		grid-template-rows var(--duration-smooth) var(--ease-out-expo);
	}

	/* Suppress the column transition while dragging so resize feels instant */
	.app-shell.is-resizing {
		transition: none;
	}

	/* ── Rail (always-visible project switcher) ── */
	.rail-area {
		grid-area: rail;
		position: relative;
		overflow: hidden;
		/* Match the chrome gap on the rail's right (which comes from main's
		   margin) so the rail's icons read as visually centered between
		   viewport edge and main pane when the sidebar is collapsed. */
		padding-left: var(--spacing-island);
	}

	/* ── Sidebar area ── */
	.sidebar-area {
		grid-area: sidebar;
		position: relative;
		overflow: hidden;
	}

	/* ── Resize handle ── */
	.resize-handle {
		position: absolute;
		right: -2px;
		top: 0;
		bottom: 0;
		width: 5px;
		cursor: col-resize;
		z-index: 10;
		background: transparent;
	}

	/* Visible only on hover/active — transparent at rest so the handle
	   doesn't print a hairline into the chrome gap. */
	.resize-handle::after {
		content: '';
		position: absolute;
		inset: 0;
		left: 2px;
		width: 1px;
		background: transparent;
		transition:
			width var(--duration-snap) var(--ease-soft),
			left var(--duration-snap) var(--ease-soft),
			background-color var(--duration-snap) var(--ease-soft);
	}

	.resize-handle:hover::after,
	.resize-handle:active::after {
		left: 1px;
		width: 3px;
		background: var(--color-border-focus, var(--color-accent));
	}

	/* ── Top bar ── */
	.topbar-area {
		grid-area: topbar;
		position: relative;
		z-index: 10;
		height: var(--topbar-height);
		background: var(--color-bg-secondary);
	}

	/* Tauri overlay title bar — traffic light clearance */
	:global(html.tauri) .topbar-area {
		height: calc(22px + var(--spacing-island));
		padding-top: 22px;
	}

	/* ── Main area ── */
	.main-area {
		grid-area: main;
		position: relative;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-height: 0;
		min-width: 0;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-island);
		margin: var(--spacing-island);
		/* Layered shadow: tight contact + soft ambient.
		   Inset top highlight catches light off the warm canvas. */
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
	}

	/* Tabs float over content — no background, no flex space reservation.
	   The pill already has backdrop-filter so content scrolling beneath
	   shows through naturally. pointer-events passthrough on the wrapper
	   so clicks reach content in the transparent zone around the pill. */
	.main-tab-bar {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 10;
		display: flex;
		justify-content: center;
		padding: 10px 0 8px;
		pointer-events: none;
	}

	.main-tab-bar :global(*) {
		pointer-events: auto;
	}

	.main-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	:global(:root.dark) .main-area {
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 4%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 40%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 50%, transparent);
	}

	/* ── Userbar (bottom-left chrome strip holding the user menu) ──
	   Spans the rail + sidebar columns in row 3, sharing the row with the
	   bottombar to its right. Together they form one continuous chrome band
	   across the bottom of the viewport — same bg, same height, no divider.
	   Separation from the scrolling PR list (and the rail's avatar column)
	   above is handled by an in-pane fade overlay at the bottom of each
	   column (.sidebar-fade, .rail-fade) so content dissolves into the
	   chrome instead of hitting a hard edge. */
	.userbar-area {
		grid-area: userbar;
		background: var(--color-bg-secondary);
		padding-left: var(--spacing-island);
		padding-bottom: var(--spacing-island);
		display: flex;
		align-items: center;
		overflow: visible;
		position: relative;
		z-index: 10;
		min-width: 0;
	}

	.bottombar-area {
		grid-area: bottombar;
		padding-bottom: var(--spacing-island);
	}

	/* Bottom-anchored action bar. Floats over the main pane content,
	   mirroring the tab bar at the top. pointer-events: none on the
	   wrapper lets clicks reach content in the transparent zone. */
	.walkthrough-actions-float {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		padding: 8px 0 10px;
		z-index: 10;
		pointer-events: none;
	}

	.walkthrough-actions-float :global(*) {
		pointer-events: auto;
	}

	.walkthrough-actions-row {
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-island);
	}

	/* ── Right pane (chat) ──
	   A real grid column. Width is 0 when closed, rightPanelWidth when
	   open; toggling shrinks the main column rather than overlaying. The
	   open/close animation comes from the grid-template-columns transition
	   on .app-shell.

	   Margin pattern mirrors .main-area's island (top / bottom / right =
	   spacing-island) but margin-left is 0 — main's own margin-right
	   already produces the chrome gap between the two islands, so adding
	   margin-left here would double it. */
	.rightpanel-area {
		grid-area: rightpanel;
		position: relative;
		overflow: hidden;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-island);
		margin: var(--spacing-island) var(--spacing-island) var(--spacing-island) 0;
		/* Mirrors .main-area's island elevation so both panes float
		   identically inside the chrome. */
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
		/* min-width: 0 lets the grid track shrink to 0 even though the
		   border-box would otherwise contribute its own min-content. */
		min-width: 0;
		/* Border + shadow fade in sync with the grid-column open/close
		   animation so the chrome doesn't flash a borderless panel
		   mid-transition. */
		transition:
			border-color var(--duration-smooth) var(--ease-out-expo),
			box-shadow var(--duration-smooth) var(--ease-out-expo);
	}

	:global(:root.dark) .rightpanel-area {
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 4%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 40%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 50%, transparent);
	}

	/* When closed, the grid column collapses to 0 and the cell has no
	   visible width; hide the border + shadow that would otherwise
	   render as a sliver against the chrome's right edge. */
	.rightpanel-area:not(.rightpanel-area--open) {
		border-color: transparent;
		box-shadow: none;
	}

	/* Left-edge resize handle — mirrors `.resize-handle` on the sidebar but
	   anchored to the panel's *left* edge (toward the main pane). 5px hit
	   area, 1px visible line, expands to 3px on hover/active using the
	   accent border color. */
	.right-resize-handle {
		position: absolute;
		left: -2px;
		top: 0;
		bottom: 0;
		width: 5px;
		cursor: col-resize;
		z-index: 10;
		background: transparent;
	}

	.right-resize-handle::after {
		content: '';
		position: absolute;
		inset: 0;
		left: 2px;
		width: 1px;
		background: transparent;
		transition:
			width var(--duration-snap) var(--ease-soft),
			left var(--duration-snap) var(--ease-soft),
			background-color var(--duration-snap) var(--ease-soft);
	}

	.right-resize-handle:hover::after,
	.right-resize-handle:active::after {
		left: 1px;
		width: 3px;
		background: var(--color-border-focus, var(--color-accent));
	}

/* Merge split-button — single pill with transparent inner buttons so the
	   wrapper’s `.glass-pill` border and radius create the shape. */
	.merge-pill {
		padding: 0;
		overflow: hidden;
	}

	.merge-pill.is-disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.merge-pill-main,
	.merge-pill-chevron {
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-island);
		height: 100%;
		padding: 0 var(--spacing-inset);
		background: transparent;
		border: none;
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.01em;
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
		transition: background-color var(--duration-snap);
		-webkit-font-smoothing: antialiased;
	}

	.merge-pill-chevron {
		padding: 0 10px 0 2px;
		border-left: 1px solid var(--color-glass-border);
	}

	.merge-pill-main:hover:not(:disabled),
	.merge-pill-chevron:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-tab-active-bg) 80%, var(--color-tab-track-bg));
	}

	.merge-pill-main:disabled,
	.merge-pill-chevron:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}
</style>
