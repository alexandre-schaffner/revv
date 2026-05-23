<script lang="ts">
import ArrowCounterClockwise from "phosphor-svelte/lib/ArrowCounterClockwise";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Check from "phosphor-svelte/lib/Check";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import Circle from "phosphor-svelte/lib/Circle";
import Copy from "phosphor-svelte/lib/Copy";
import Gear from "phosphor-svelte/lib/Gear";
import GitBranch from "phosphor-svelte/lib/GitBranch";
import GitCommit from "phosphor-svelte/lib/GitCommit";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import Lightbulb from "phosphor-svelte/lib/Lightbulb";
import MagicWand from "phosphor-svelte/lib/MagicWand";
import PaperPlaneTilt from "phosphor-svelte/lib/PaperPlaneTilt";
import Robot from "phosphor-svelte/lib/Robot";
import Spinner from "phosphor-svelte/lib/Spinner";
import Trash from "phosphor-svelte/lib/Trash";
import UploadSimple from "phosphor-svelte/lib/UploadSimple";
import Warning from "phosphor-svelte/lib/Warning";
import X from "phosphor-svelte/lib/X";
import XCircle from "phosphor-svelte/lib/XCircle";
import { tick } from "svelte";
import { cubicIn, cubicOut } from "svelte/easing";
import { fly, slide } from "svelte/transition";

const TOOL_CALL_ROW_H = 14; // px — match walkthrough's compact tool-call rows

import { toast } from "svelte-sonner";
import { fetchProposedDiffFiles, type ProposedDiffFile } from "$lib/api/chat";
import { Checkpoint } from "$lib/components/ai/checkpoint";
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationContent,
  ConfirmationHeader,
} from "$lib/components/ai/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "$lib/components/ai/conversation";
import { Message, MessageContent, MessageResponse } from "$lib/components/ai/message";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanFooter,
  PlanHeader,
  PlanTitle,
} from "$lib/components/ai/plan";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  type PromptInputStatus,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "$lib/components/ai/prompt-input";
import { Question } from "$lib/components/ai/question";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "$lib/components/ai/queue";
import { Suggestion, SuggestionItem } from "$lib/components/ai/suggestion";
import type { ToolState } from "$lib/components/ai/tool";
import { Tool, ToolContent, ToolHeader, ToolOutput } from "$lib/components/ai/tool";
import ProposedDiffModal from "$lib/components/review/ProposedDiffModal.svelte";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Dialog from "$lib/components/ui/dialog";
import { Dotmatrix, squareVariantForId } from "$lib/components/ui/dotmatrix/index.js";
import { Input } from "$lib/components/ui/input";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  abortChatTurn,
  approvePlanAction,
  batchCherryPickSelectedAction,
  batchDiscardSelectedAction,
  cherryPickProposedCommitAction,
  clearChatHistory,
  clearCommitSelection,
  discardProposedCommitAction,
  enqueueMessage,
  getChatError,
  getChatItems,
  getCheckpoints,
  getInteractionMode,
  getProposedChanges,
  getQueuedMessages,
  getSelectedCommitCount,
  getSelectedCommitShas,
  getToolApprovals,
  getWorktreeBlocked,
  isBatchOpInFlight,
  isChatStreaming,
  isCherryPickingCommit,
  isCommitSelected,
  isDiscardingCommit,
  isPlanModeAvailable,
  isPushingProposed,
  isRebasingProposed,
  isResolvingPush,
  loadAvailableAgents,
  loadChatHistory,
  pushProposed,
  rebaseAllProposedAction,
  refreshProposedChanges,
  rejectPlanAction,
  removeQueuedMessage,
  resolveAndPushProposed,
  respondToToolApproval,
  restoreToCheckpoint,
  selectAllCommits,
  sendChatMessage,
  setInteractionMode,
  toggleCommitSelection,
} from "$lib/stores/chat.svelte";
import { getSelectedPr } from "$lib/stores/prs.svelte";
import { getLoadedHeadSha } from "$lib/stores/review.svelte";
import {
  FALLBACK_PROMPTS,
  fetchSuggestions,
  getSuggestions,
  isSuggestionsLoading,
} from "$lib/stores/suggestions.svelte";
import { renderMarkdown } from "$lib/utils/markdown";
import StreamingVerb from "./StreamingVerb.svelte";

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
      .filter(
        (i): i is Extract<typeof i, { kind: "message" }> =>
          i.kind === "message" &&
          i.role === "assistant" &&
          i.isStreaming &&
          typeof i.turnId === "string",
      )
      .map((i) => i.turnId as string),
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
const selectedShas = $derived(
  prId ? getSelectedCommitShas(prId) : (new Set<string>() as Set<string>),
);
const selectedCount = $derived(selectedShas.size);
const allSelected = $derived(commitCount > 0 && selectedCount === commitCount);
const batchInFlight = $derived(prId ? isBatchOpInFlight(prId) : false);
const selectedPr = $derived(getSelectedPr());
const interactionMode = $derived(prId ? getInteractionMode(prId) : "default");
const planModeAvailable = $derived(isPlanModeAvailable());
const queuedMessages = $derived(prId ? getQueuedMessages(prId) : []);
const chatCheckpoints = $derived(prId ? getCheckpoints(prId) : []);
const toolApprovals = $derived(prId ? getToolApprovals(prId) : []);
/** Index → checkpoint lookup for interleaving in the message loop. */
const checkpointByAfterIndex = $derived(new Map(chatCheckpoints.map((cp) => [cp.afterIndex, cp])));
/** Pending (un-responded) tool approvals, rendered after the last message. */
const pendingApprovals = $derived(toolApprovals.filter((a) => !a.responded));
/** Most recent task list from the agent — surfaces in the Queue dock. */
const activeTasks = $derived.by(() => {
  const taskList = items.findLast(
    (i): i is Extract<typeof i, { kind: "task-list" }> => i.kind === "task-list",
  );
  return taskList ? taskList.tasks : [];
});
/** Whether the Queue dock should be visible. */
const showQueueDock = $derived(
  queuedMessages.length > 0 || activeTasks.length > 0 || commitCount > 0,
);

const streamingTurnId = $derived(
  items.findLast(
    (i): i is Extract<typeof i, { kind: "message" }> =>
      i.kind === "message" && i.role === "assistant" && i.isStreaming,
  )?.turnId,
);
const recentToolCalls = $derived(
  streamingTurnId
    ? items
        .filter(
          (i): i is Extract<typeof i, { kind: "activity" }> =>
            i.kind === "activity" && i.turnId === streamingTurnId,
        )
        .slice(-2)
    : [],
);

let diffOpen = $state<{
  sha: string;
  subject: string;
  fileContents: ProposedDiffFile[] | null;
} | null>(null);
let conflictDialog = $state<{ files: string[]; branch: string } | null>(null);
let pushSuccessTrigger = $state(0);
let pushPillEl = $state<HTMLDivElement | null>(null);

// Pulse animation on push success — toggles a CSS animation class
$effect(() => {
  const _trigger = pushSuccessTrigger;
  if (!pushPillEl || _trigger === 0) return;
  pushPillEl.classList.remove("push-pill--pulse");
  // Force reflow so re-adding the class restarts the animation
  void pushPillEl.offsetWidth;
  pushPillEl.classList.add("push-pill--pulse");
});
let pushMenuOpen = $state(false);
// "Push to new branch" dialog. `input` mode collects the branch name;
// `confirm-overwrite` is the inline confirmation shown when the remote
// already has that ref.
let newBranchDialogOpen = $state(false);
let newBranchDialogMode = $state<"input" | "confirm-overwrite">("input");
let newBranchValue = $state("");
let newBranchInputEl: HTMLInputElement | null = $state(null);

// Hydrate on initial mount AND on PR switch. The panel is mounted once in
// AppShell and just gets a new `prId` prop on navigation, so this $effect
// is the only place that fires on PR switch. `loadChatHistory` is
// idempotent (gated by `loadedPrIds`); `refreshProposedChanges` always
// re-fetches so the strip reflects the freshly-selected PR's worktree.
$effect(() => {
  if (prId) {
    void refreshProposedChanges(prId);
    void loadChatHistory(prId);
    void loadAvailableAgents();
  }
});

// Re-fetch chat history when a pull lands and stamps a new head SHA.
// Gated on a non-null SHA so this doesn't fire on initial mount
// (the hydration effect above handles that case).
$effect(() => {
  if (!prId) return;
  const headSha = getLoadedHeadSha(prId);
  if (headSha === null) return;
  void loadChatHistory(prId);
});

function handleTogglePlanMode(): void {
  if (!prId || !planModeAvailable) return;
  const next = interactionMode === "plan" ? "default" : "plan";
  void setInteractionMode(prId, next);
}

function handleApprovePlan(planId: string): void {
  if (!prId) return;
  void approvePlanAction(prId, planId);
}

function handleRejectPlan(planId: string): void {
  if (!prId) return;
  void rejectPlanAction(prId, planId);
}

function nestedActivitiesFor(invocationId: string) {
  return items.filter(
    (i): i is Extract<typeof i, { kind: "activity" }> =>
      i.kind === "activity" && i.subagentInvocationId === invocationId,
  );
}

function handlePromptSubmit(message: PromptInputMessage): void {
  if (!prId) return;
  const value = message.text.trim();
  if (value.length === 0) return;
  if (isStreaming) {
    // Agent is busy — queue the message for dispatch when it finishes.
    enqueueMessage(prId, value);
  } else {
    sendChatMessage({ prId, message: value });
  }
}

const inputStatus = $derived<PromptInputStatus>(isStreaming ? "streaming" : "ready");

// Empty-state suggestions: prefer the model-generated, PR-aware list
// from the suggestions store; fall back to the static prompts before
// the first fetch lands (or on any server failure).
const suggestedPrompts = $derived<readonly string[]>(
  (prId ? getSuggestions(prId) : null) ?? FALLBACK_PROMPTS,
);
const suggestionsLoading = $derived(
  prId ? isSuggestionsLoading(prId) && getSuggestions(prId) === null : false,
);

// Lazily fetch PR-aware suggestions whenever the empty state would
// actually be visible — chat has no items yet for this PR. Skipping
// this when chat already has history avoids spending tokens on PRs
// the user has already interacted with.
$effect(() => {
  if (!prId) return;
  if (items.length > 0) return;
  if (getSuggestions(prId) !== null) return;
  void fetchSuggestions(prId);
});

function handleSuggestion(text: string): void {
  if (!prId || isStreaming) return;
  sendChatMessage({ prId, message: text });
}

async function handleClear(): Promise<void> {
  if (!prId) return;
  await clearChatHistory(prId);
}

async function handlePush(): Promise<void> {
  if (!prId || isPushing || isStreaming || isResolving) return;
  const result = await pushProposed(prId);
  if (!result) return;
  if (result.status === "pushed") {
    pushSuccessTrigger++;
  } else if (result.status === "conflict") {
    conflictDialog = { files: result.files, branch: result.branch };
  }
  // remote-changed already toasts in the store; no extra UI here.
}

function suggestedNewBranchName(): string {
  const base = selectedPr?.sourceBranch?.trim();
  return base && base.length > 0 ? `${base}-agent` : "agent-changes";
}

function openNewBranchDialog(): void {
  pushMenuOpen = false;
  newBranchDialogMode = "input";
  newBranchValue = suggestedNewBranchName();
  newBranchDialogOpen = true;
  // Focus + select on the next tick so the dialog is in the DOM first.
  void tick().then(() => newBranchInputEl?.select());
}

function isValidNewBranchName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith("-")) return false;
  if (trimmed.includes("..")) return false;
  return true;
}

async function handleNewBranchSubmit(): Promise<void> {
  if (!prId || newBranchDialogMode !== "input") return;
  const name = newBranchValue.trim();
  if (!isValidNewBranchName(name)) return;
  const result = await pushProposed(prId, { newBranchName: name });
  if (!result) {
    // Hard failure already toasted by the store.
    newBranchDialogOpen = false;
    return;
  }
  if (result.status === "pushed") {
    pushSuccessTrigger++;
    newBranchDialogOpen = false;
    return;
  }
  if (result.status === "ref-exists") {
    newBranchValue = name;
    newBranchDialogMode = "confirm-overwrite";
    return;
  }
  // 'conflict' / 'remote-changed' don't apply to the new-branch path,
  // but if the server ever returns one we surface it as a generic close.
  newBranchDialogOpen = false;
}

async function handleConfirmOverwrite(): Promise<void> {
  if (!prId || newBranchDialogMode !== "confirm-overwrite") return;
  const result = await pushProposed(prId, {
    newBranchName: newBranchValue,
    force: true,
  });
  if (!result) {
    newBranchDialogOpen = false;
    return;
  }
  if (result.status === "pushed") {
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
  // Open modal immediately — ProposedDiffModal renders a skeleton when fileContents is null
  diffOpen = { sha: commit.sha, subject: commit.subject, fileContents: null };
  try {
    const fileContents = await fetchProposedDiffFiles(prId, commit.sha);
    // Only update if the user hasn't dismissed the modal already
    if (diffOpen) diffOpen = { sha: commit.sha, subject: commit.subject, fileContents };
  } catch (err) {
    diffOpen = null;
    toast.error(err instanceof Error ? err.message : "Failed to load diff");
  }
}

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text);
}

function filesSummary(files: string[]): string {
  const basenames = files.map((f) => f.split("/").pop() ?? f);
  if (basenames.length === 1) return basenames[0] ?? "";
  if (basenames.length === 2) return `${basenames[0]} · ${basenames[1]}`;
  return `${basenames[0]} · +${basenames.length - 1} more`;
}

function messageHtml(content: string): string {
  return content ? renderMarkdown(content) : "";
}

function activitiesForTurn(
  turnId: string | undefined,
): Extract<(typeof items)[number], { kind: "activity" }>[] {
  if (!turnId) return [];
  return items.filter(
    (i): i is Extract<(typeof items)[number], { kind: "activity" }> =>
      i.kind === "activity" && i.turnId === turnId,
  );
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
					bind:this={pushPillEl}
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
							<Spinner size={12} weight="fill" class="motion-essential-spin" />
							<span class="push-pill-label">Pushing…</span>
						{:else}
							<UploadSimple size={12} weight="fill" />
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
								<CaretDown size={11} weight="fill" />
							</button>
						</PopoverTrigger>
						<PopoverContent class="w-72 p-1" align="end" side="bottom">
							<button
								type="button"
								class="push-menu-item"
								onclick={openNewBranchDialog}
							>
								<GitBranch size={12} weight="fill" class="push-menu-item-icon" />
								<div class="push-menu-item-body">
									<span class="push-menu-item-title">Push to new branch…</span>
									<span class="push-menu-item-hint">
										Don't change the PR. Push the agent's commits to a new ref.
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
					title={commitCount > 0
						? `Clear conversation and discard ${commitCount} proposed commit${commitCount === 1 ? '' : 's'}`
						: 'Clear conversation'}
					aria-label={commitCount > 0
						? 'Clear conversation and discard proposed commits'
						: 'Clear conversation'}
					disabled={isPushing || isResolving}
				>
					<MagicWand size={13} weight="fill" />
				</button>
			{/if}
			<button class="icon-btn" onclick={onClose} aria-label="Close panel">
				<X size={14} weight="fill" />
			</button>
		</div>
	</div>

	<!-- Blocked-by-unpushed-commits strip -->
	{#if blocked}
		<div class="blocked-strip">
			<div class="blocked-header">
				<Warning size={12} weight="fill" class="blocked-icon" />
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
						<Spinner size={11} weight="fill" class="motion-essential-spin" />
						<span>Rebasing…</span>
					{:else}
						<ArrowCounterClockwise size={11} weight="fill" />
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
								<Spinner size={10} weight="fill" class="motion-essential-spin" />
							{:else}
								<Trash size={10} weight="fill" />
							{/if}
						</button>
					</li>
				{/each}
			</ul>
			<p class="blocked-hint">Rebase or discard all commits to continue chatting with the updated PR.</p>
		</div>
	{/if}

	<!-- Messages -->
	<Conversation
		resetKey={prId}
		innerClass="min-h-0"
	>
		{#if items.length === 0 && !error}
			<ConversationEmptyState
				title="Ask the agent about this pull request"
				description="The agent runs inside the PR's worktree and can read the code, propose fixes, and commit them on a working branch."
				class="pb-32"
			>
				{#snippet icon()}
					<Robot size={32} weight="fill" />
				{/snippet}
				<Suggestion class="mt-3 justify-center">
					{#each suggestedPrompts as prompt (prompt)}
						<SuggestionItem
							onSelect={(text) => handleSuggestion(text)}
							disabled={!prId || suggestionsLoading}
						>
							{prompt}
						</SuggestionItem>
					{/each}
				</Suggestion>
			</ConversationEmptyState>
		{:else}
			<ConversationContent class="gap-2 px-2.5 pt-3 pb-32">
				{#each items as item, itemIdx (item.id)}
				{#if item.kind === 'activity'}
						<!-- Skip nested sub-agent tool calls — they render
							 inside their SubagentInvocation card. Also fold
							 active-turn tool calls into the dot-matrix
							 indicator below. -->
						{#if !item.subagentInvocationId && !(item.turnId && streamingTurnIds.has(item.turnId))}
							<div class="tool-line">
								<span class="tool-bullet">&rsaquo;</span>
								<span class="tool-text">{item.summary}</span>
							</div>
						{/if}
					{:else if item.kind === 'task-list'}
						<!-- Rendered exclusively in the Queue dock below. -->
					{:else if item.kind === 'plan'}
						<Plan
							class={item.status === 'rejected' ? 'opacity-85 border-destructive/35' : item.status === 'approved' ? 'border-success/35' : ''}
						>
							<PlanHeader>
								<PlanTitle>Plan</PlanTitle>
								{#if item.status === 'approved'}
									<span class="ml-auto inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-success">
										<CheckCircle class="size-2.5" />
										Approved
									</span>
								{:else if item.status === 'rejected'}
									<span class="ml-auto inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-destructive">
										<XCircle class="size-2.5" />
										Rejected
									</span>
								{:else if item.status === 'superseded'}
									<span class="ml-auto inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Superseded
									</span>
								{/if}
							</PlanHeader>
							<PlanContent class="text-sm leading-relaxed">
								{@html messageHtml(item.markdown)}
							</PlanContent>
							{#if item.status === 'pending'}
								<PlanFooter>
									<PlanAction
										variant="outline"
										onclick={() => handleRejectPlan(item.id)}
										disabled={isStreaming}
									>
										<X data-icon="inline-start" />
										Reject
									</PlanAction>
									<PlanAction
										onclick={() => handleApprovePlan(item.id)}
										disabled={isStreaming}
									>
										<Check data-icon="inline-start" />
										Approve & continue
									</PlanAction>
								</PlanFooter>
							{/if}
						</Plan>
					{:else if item.kind === 'subagent'}
						{@const toolState = (item.status === 'running' ? 'input-available' : item.status === 'errored' ? 'output-error' : 'output-available') as ToolState}
						<Tool open={item.status === 'running'}>
							<ToolHeader
								toolType={item.subagentType}
								title={item.description}
								state={toolState}
							/>
							<ToolContent>
								{#if nestedActivitiesFor(item.id).length > 0}
									<div class="space-y-0.5">
										{#each nestedActivitiesFor(item.id) as activity (activity.id)}
											<div class="flex items-baseline gap-1.5 text-xs text-muted-foreground">
												<span class="font-semibold text-muted-foreground/60">&rsaquo;</span>
												<span class="flex-1 min-w-0 break-words">{activity.summary}</span>
											</div>
										{/each}
									</div>
								{/if}
								{#if item.status === 'errored'}
									<ToolOutput class="mt-2" errorText={item.result ?? 'Sub-agent errored'} />
								{:else if item.status === 'completed' && item.result}
									<ToolOutput class="mt-2">
										{#snippet output()}
											<pre class="overflow-x-auto rounded-md bg-muted p-2.5 text-xs font-mono whitespace-pre-wrap break-words">{item.result}</pre>
										{/snippet}
									</ToolOutput>
								{/if}
								{#if item.status === 'running' && nestedActivitiesFor(item.id).length === 0}
									<p class="text-xs italic text-muted-foreground">Waiting for the sub-agent to start&hellip;</p>
								{/if}
							</ToolContent>
						</Tool>
					{:else if item.kind === 'question'}
						<Question
							prId={prId ?? ""}
							itemId={item.id}
							questions={item.questions}
							status={item.status}
							answers={item.answers}
							customAnswers={item.customAnswers}
							previewFormat={item.previewFormat}
						/>
				{:else if item.role === 'user'}
					<Message from="user">
						<MessageContent>
							<MessageResponse content={item.content} class="rounded-[14px] rounded-br-[4px] bg-accent px-3 py-2 text-sm leading-relaxed text-white [&_a]:text-white [&_a]:underline [&_code]:bg-black/20 [&_code]:text-xs [&_pre]:bg-black/20" />
						</MessageContent>
					</Message>
				{:else if item.kind === 'message' && item.role === 'assistant'}
					<Message from="assistant">
						<MessageContent>
							{#if item.content}
								<MessageResponse content={item.content} class="text-sm leading-relaxed" />
							{/if}
							{#if item.error}
								<div class="mt-2 flex items-start gap-1.5 rounded border border-border bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground" role="alert">
									<Warning size={12} weight="fill" class="mt-0.5 shrink-0" />
									<span class="min-w-0 break-words">{item.error}</span>
								</div>
							{/if}
						</MessageContent>
					</Message>
					{/if}

					<!-- Checkpoint marker (if one was placed after this item) -->
					{#if checkpointByAfterIndex.has(itemIdx)}
						{@const cp = checkpointByAfterIndex.get(itemIdx)}
						{#if cp}
							<Checkpoint
								id={cp.id}
								label={cp.label}
								onRestore={(id) => prId && restoreToCheckpoint(prId, id)}
							/>
						{/if}
					{/if}
				{/each}

				<!-- Pending tool approvals — shown at the bottom of the timeline -->
				{#each pendingApprovals as approval (approval.id)}
					<Confirmation
						tool={approval.tool}
						message={approval.message}
						responded={approval.responded}
						onApprove={() => prId && respondToToolApproval(prId, approval.id, 'approved')}
						onDeny={() => prId && respondToToolApproval(prId, approval.id, 'denied')}
					>
						<ConfirmationHeader
							title={approval.tool}
							description={approval.message}
						/>
						{#if approval.input}
							<ConfirmationContent>
								<pre class="overflow-x-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-words">{typeof approval.input === 'string' ? approval.input : JSON.stringify(approval.input, null, 2)}</pre>
							</ConfirmationContent>
						{/if}
						<ConfirmationActions
							responded={approval.responded}
							onApprove={() => prId && respondToToolApproval(prId, approval.id, 'approved')}
							onDeny={() => prId && respondToToolApproval(prId, approval.id, 'denied')}
						/>
					</Confirmation>
				{/each}
			</ConversationContent>
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
					<Gear size={24} weight="fill" class="error-icon" />
					<p class="error-primary">AI not configured</p>
					<p class="error-hint">
						Install <a href="https://opencode.ai" class="error-link">opencode</a>
						or <a href="https://claude.ai/code" class="error-link">Claude Code</a>
						and authenticate, then select your CLI agent in <a href="/settings" class="error-link">Gear</a>.
					</p>
				{:else if error.code === 'RATE_LIMITED'}
					<Warning size={24} weight="fill" class="error-icon" />
					<p class="error-primary">Rate limited</p>
					<p class="error-hint">{error.message}</p>
				{:else}
					<Warning size={24} weight="fill" class="error-icon" />
					<p class="error-primary">Chat failed</p>
					<p class="error-hint">{error.message}</p>
				{/if}
			</div>
		{/if}
		<ConversationScrollButton />
	</Conversation>

	<!-- Floating composer: queue dock + chat input share one glass surface
		 anchored to the panel bottom; messages scroll underneath them. -->
	<div class="composer-float">
	<!-- Queue dock: proposed commits + agent tasks + queued messages -->
	{#if showQueueDock}
		<div class="queue-dock" transition:slide={{ duration: 220, easing: cubicOut }}>
			<Queue class="composer-glass rounded-t-xl rounded-b-none border-b-0 shadow-none">
				<!-- Proposed commits from the agent -->
				{#if commitCount > 0 && proposed}
					<div transition:slide={{ duration: 220, easing: cubicOut }}>
						<QueueSection open={true}>
							<QueueSectionTrigger>
								<QueueSectionLabel
									label={commitCount === 1 ? 'proposed commit' : 'proposed commits'}
									count={commitCount}
								>
									{#snippet icon()}
										<GitCommit class="size-3 text-accent" />
									{/snippet}
								</QueueSectionLabel>
								{#if proposed.branchName}
									<span class="ml-auto max-w-[140px] truncate font-mono text-xs text-muted-foreground">
										{proposed.branchName}
									</span>
								{/if}
							</QueueSectionTrigger>
							<QueueSectionContent>
								<QueueList>
									{#each proposed.commits as commit, commitIdx (commit.sha)}
										{@const checked = prId ? isCommitSelected(prId, commit.sha) : false}
										<div
											in:fly={{ y: 4, duration: 160, delay: Math.min(commitIdx, 8) * 25, easing: cubicOut }}
											out:fly={{ y: -4, duration: 120, easing: cubicIn }}
										>
											<QueueItem class="items-start gap-2 py-1.5">
												<Checkbox
													class="mt-0.5"
													{checked}
													disabled={batchInFlight}
													aria-label="Select commit {commit.shortSha} for batch action"
													onclick={(e) => e.stopPropagation()}
													onCheckedChange={() => {
														if (prId) toggleCommitSelection(prId, commit.sha);
													}}
												/>
												<button
													type="button"
													class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-0 bg-transparent p-0 text-left"
													onclick={() => void openDiff(commit)}
													title="View diff"
												>
													<span class="flex min-w-0 items-center gap-2">
														<code class="shrink-0 font-mono text-[10px] text-accent">{commit.shortSha}</code>
														<span class="truncate text-xs text-foreground">{commit.subject}</span>
													</span>
													{#if commit.files.length > 0}
														<span class="truncate font-mono text-[10px] text-muted-foreground">
															{filesSummary(commit.files)}
														</span>
													{/if}
												</button>
												{#if selectedCount === 0}
													<QueueItemActions>
														<QueueItemAction
															class="opacity-100"
															onclick={() => copyToClipboard(commit.sha)}
															aria-label="Copy SHA"
															title="Copy SHA"
														>
															<Copy class="size-3" />
														</QueueItemAction>
														<QueueItemAction
															class="opacity-100 hover:text-destructive"
															disabled={isDiscardingCommit(commit.sha)}
															onclick={() => {
																if (prId) void discardProposedCommitAction(prId, commit.sha);
															}}
															aria-label="Discard commit"
															title="Discard commit"
														>
															{#if isDiscardingCommit(commit.sha)}
																<Spinner class="size-3 motion-essential-spin" />
															{:else}
																<Trash class="size-3" />
															{/if}
														</QueueItemAction>
														<QueueItemAction
															class="opacity-100 hover:text-primary"
															disabled={isCherryPickingCommit(commit.sha)}
															onclick={() => {
																if (prId) void cherryPickProposedCommitAction(prId, commit.sha);
															}}
															aria-label="Push this commit to PR branch"
															title="Push this commit to PR branch"
														>
															{#if isCherryPickingCommit(commit.sha)}
																<Spinner class="size-3 motion-essential-spin" />
															{:else}
																<GitMerge class="size-3" />
															{/if}
														</QueueItemAction>
													</QueueItemActions>
												{/if}
											</QueueItem>
										</div>
									{/each}
								</QueueList>
								{#if selectedCount > 0}
									<div
										class="proposed-batch-footer"
										transition:slide={{ duration: 160, easing: cubicOut }}
									>
										<div class="proposed-batch-footer__info">
											<span class="text-xs text-muted-foreground tabular-nums">
												{selectedCount} of {commitCount} selected
											</span>
											{#if !allSelected}
												<button
													type="button"
													class="proposed-batch-footer__link"
													disabled={batchInFlight}
													onclick={() => {
														if (prId)
															selectAllCommits(prId, proposed.commits.map((c) => c.sha));
													}}
												>
													Select all
												</button>
											{/if}
											<button
												type="button"
												class="proposed-batch-footer__link"
												disabled={batchInFlight}
												onclick={() => {
													if (prId) clearCommitSelection(prId);
												}}
											>
												Clear
											</button>
										</div>
										<div class="proposed-batch-footer__actions">
											<Button
												variant="ghost"
												size="sm"
												class="h-7 gap-1.5 px-2 text-xs hover:text-destructive"
												disabled={batchInFlight}
												onclick={() => {
													if (prId) void batchDiscardSelectedAction(prId);
												}}
											>
												{#if batchInFlight}
													<Spinner class="size-3 motion-essential-spin" />
												{:else}
													<Trash class="size-3" />
												{/if}
												Discard {selectedCount}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												class="h-7 gap-1.5 px-2 text-xs hover:text-primary"
												disabled={batchInFlight}
												onclick={() => {
													if (prId) void batchCherryPickSelectedAction(prId);
												}}
											>
												{#if batchInFlight}
													<Spinner class="size-3 motion-essential-spin" />
												{:else}
													<GitMerge class="size-3" />
												{/if}
												Push {selectedCount} to PR branch
											</Button>
										</div>
									</div>
								{/if}
							</QueueSectionContent>
						</QueueSection>
					</div>
				{/if}

				<!-- Active todo list from the agent -->
				{#if activeTasks.length > 0}
					{@const completed = activeTasks.filter((t) => t.status === 'completed').length}
					{@const allDone = completed === activeTasks.length}
					<div transition:slide={{ duration: 220, easing: cubicOut }}>
						<QueueSection open={!allDone}>
							<QueueSectionTrigger>
								<QueueSectionLabel
									label={activeTasks.length === 1 ? 'todo' : 'todos'}
									count={activeTasks.length}
								>
									{#snippet icon()}
										{#if activeTasks.some((t) => t.status === 'in_progress')}
											<Spinner class="size-3 text-primary motion-essential-spin animate-spin" />
										{:else if allDone}
											<CheckCircle class="size-3 text-success" />
										{:else}
											<Circle class="size-3 text-muted-foreground" />
										{/if}
									{/snippet}
								</QueueSectionLabel>
								<span class="ml-auto text-xs tabular-nums text-muted-foreground">
									{completed}/{activeTasks.length}
								</span>
							</QueueSectionTrigger>
							<QueueSectionContent>
								<QueueList>
									{#each activeTasks as task, taskIdx (task.id)}
										<div
											in:fly={{ y: 4, duration: 160, delay: Math.min(taskIdx, 8) * 25, easing: cubicOut }}
											out:fly={{ y: -4, duration: 120, easing: cubicIn }}
										>
											<QueueItem>
												<QueueItemIndicator completed={task.status === 'completed'} />
												<QueueItemContent completed={task.status === 'completed'}>
													{#if task.status === 'in_progress' && task.activeForm}
														{task.activeForm}
													{:else}
														{task.content}
													{/if}
												</QueueItemContent>
											</QueueItem>
										</div>
									{/each}
								</QueueList>
							</QueueSectionContent>
						</QueueSection>
					</div>
				{/if}

				<!-- Queued messages (submitted while agent is busy) -->
				{#if queuedMessages.length > 0}
					<div transition:slide={{ duration: 220, easing: cubicOut }}>
						<QueueSection>
							<QueueSectionTrigger>
								<QueueSectionLabel
									label={queuedMessages.length === 1 ? 'queued message' : 'queued messages'}
									count={queuedMessages.length}
								>
									{#snippet icon()}
										<PaperPlaneTilt class="size-3 text-muted-foreground" />
									{/snippet}
								</QueueSectionLabel>
							</QueueSectionTrigger>
							<QueueSectionContent>
								<QueueList>
									{#each queuedMessages as msg, msgIdx (msg.id)}
										<div
											in:fly={{ y: 4, duration: 160, delay: Math.min(msgIdx, 8) * 25, easing: cubicOut }}
											out:fly={{ y: -4, duration: 120, easing: cubicIn }}
										>
											<QueueItem>
												<QueueItemContent>{msg.text}</QueueItemContent>
												<QueueItemActions>
													<QueueItemAction
														onclick={() => prId && removeQueuedMessage(prId, msg.id)}
														aria-label="Remove queued message"
													>
														<X class="size-3" />
													</QueueItemAction>
												</QueueItemActions>
											</QueueItem>
										</div>
									{/each}
								</QueueList>
							</QueueSectionContent>
						</QueueSection>
					</div>
				{/if}
			</Queue>
		</div>
	{/if}

	<!-- Input -->
	<div>
		<PromptInput
			onsubmit={handlePromptSubmit}
			onstop={handleStop}
			status={inputStatus}
			class={'composer-glass composer-glass-input transition-[border-color,box-shadow] duration-quick ease-out-expo' + (showQueueDock ? ' composer-glass--attached rounded-t-none border-t-0' : '') + (!prId ? ' opacity-60' : '')}
		>
			<PromptInputBody>
				<PromptInputTextarea
					placeholder="Ask anything…"
					disabled={!prId}
					class="text-sm leading-relaxed"
				/>
			</PromptInputBody>
			<PromptInputFooter>
				<PromptInputTools>
					<PromptInputButton
						tooltip={
							planModeAvailable
								? interactionMode === 'plan'
									? 'Plan mode is on. The agent will propose a plan instead of editing. Click to disable.'
									: 'Enable plan mode: ask the agent to propose a plan first.'
								: 'Plan mode requires an opencode install with a `plan` agent.'
						}
						onclick={handleTogglePlanMode}
						disabled={!prId || !planModeAvailable}
						aria-pressed={interactionMode === 'plan'}
						class={interactionMode === 'plan' ? 'bg-accent/15 text-accent hover:bg-accent/25 hover:text-accent' : ''}
					>
						<Lightbulb class="size-3.5" />
					</PromptInputButton>
				</PromptInputTools>
				<PromptInputSubmit disabled={!prId} />
			</PromptInputFooter>
		</PromptInput>
	</div>
	</div>
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
				<Warning size={14} weight="fill" class="conflict-card-icon" />
				<span class="conflict-card-title">Push conflicts</span>
				<button
					class="icon-btn"
					onclick={dismissConflictDialog}
					aria-label="Close conflict dialog"
				>
					<X size={14} weight="fill" />
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
							<GitBranch size={16} weight="fill" />
							Push to a new branch
						{:else}
							<Warning size={16} weight="fill" class="new-branch-title-warn" />
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
							<Spinner size={12} weight="fill" class="motion-essential-spin" />
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
							<Spinner size={12} weight="fill" class="motion-essential-spin" />
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
		fileContents={diffOpen.fileContents}
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
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--color-panel-bg);
		overflow: hidden;
	}

	/* Floating composer: queue dock + chat input float above the
	   conversation, flush with each other so they read as one panel. */
	.composer-float {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: 10px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		pointer-events: none;
	}

	.composer-float > :global(*) {
		pointer-events: auto;
	}

	/* Shared glass surface — blur + saturate like PillTabs.
	   10px blur is the standing-chrome cap; reserve 16px for short-lived
	   overlays (dialogs, popovers, command palette). */
	:global(.composer-glass) {
		background: color-mix(in srgb, var(--color-panel-bg) 88%, transparent);
		backdrop-filter: blur(10px) saturate(1.4);
		-webkit-backdrop-filter: blur(10px) saturate(1.4);
		border-color: var(--color-glass-border);
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
	}

	/* Focus ring layered on top of the glass shadow, not replacing it. */
	:global(.composer-glass-input:focus-within) {
		border-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent),
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
	}

	:global(.composer-glass-input:hover:not(:focus-within):not(:has(:disabled))) {
		border-color: var(--color-border-hover);
	}

	/* Input attached under the queue: drop the inset top-highlight so the
	   seam reads as one panel. */
	:global(.composer-glass--attached) {
		box-shadow: var(--color-glass-shadow);
	}

	:global(.composer-glass--attached.composer-glass-input:focus-within) {
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent),
			var(--color-glass-shadow);
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
	   without flooding the panel header with color. Roboth halves are
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

	.push-pill:global(.push-pill--pulse) {
		animation: push-pill-pulse var(--duration-smooth) var(--ease-out-expo);
	}

	@keyframes push-pill-pulse {
		50% { transform: scale(1.04); }
		100% { transform: scale(1); }
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

	/* The Spinner icon needs to spin during a push. The .motion-essential-*
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

	/* Blocked-by-unpushed-commits strip */
	.blocked-strip {
		flex-shrink: 0;
		background: color-mix(in srgb, var(--color-warning) 8%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--color-warning) 25%, transparent);
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
		color: var(--color-warning);
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
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
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
		/* `top` is deliberate over `transform: translateY`: Svelte's `fly` enter
		   transition writes inline `transform`, and a base-class transform would
		   compose unpredictably with it. The animated property is bounded to
		   ±14px so the layout cost is trivial. */
		transition: top var(--duration-smooth) var(--ease-standard);
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

	/* Queue dock — floats above the composer inside the floating composer
	   group. The Queue component supplies its own border + background. */
	.queue-dock {
		display: flex;
		flex-direction: column;
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
		color: var(--color-warning);
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
		color: var(--color-danger);
	}

	.new-branch-hint code {
		font-family: var(--font-mono);
		font-size: 10.5px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
	}

	/* ── Proposed-commits batch selection ───────────────────────── */

	.proposed-batch-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 12px 8px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.proposed-batch-footer__info {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.proposed-batch-footer__actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.proposed-batch-footer__link {
		background: transparent;
		border: none;
		padding: 0;
		font-size: 11px;
		color: var(--color-text-muted);
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, var(--color-text-muted) 40%, transparent);
		text-underline-offset: 2px;
	}

	.proposed-batch-footer__link:hover:not(:disabled) {
		color: var(--color-text-secondary);
		text-decoration-color: currentColor;
	}

	.proposed-batch-footer__link:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
