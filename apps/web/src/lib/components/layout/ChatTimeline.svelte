<script lang="ts">
import {
  CaretDown,
  Check,
  CheckCircle,
  Gear,
  Robot,
  Spinner,
  Warning,
  X,
  XCircle,
} from "phosphor-svelte";
import { cubicIn, cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
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
import { Question } from "$lib/components/ai/question";
import { Shimmer } from "$lib/components/ai/shimmer";
import { Suggestion, SuggestionItem } from "$lib/components/ai/suggestion";
import type { ToolState } from "$lib/components/ai/tool";
import {
  Tool,
  ToolActivityGroup,
  ToolActivityReveal,
  ToolContent,
  ToolHeader,
  ToolOutput,
} from "$lib/components/ai/tool";
import StreamingVerb from "$lib/components/layout/StreamingVerb.svelte";
import { Dotmatrix, squareVariantForId } from "$lib/components/ui/dotmatrix/index.js";
import {
  approvePlanAction,
  enqueueMessage,
  getChatError,
  getChatItems,
  getCheckpoints,
  getToolApprovals,
  isChatStreaming,
  rejectPlanAction,
  respondToToolApproval,
  restoreToCheckpoint,
  sendChatMessage,
} from "$lib/stores/chat.svelte";
import {
  FALLBACK_PROMPTS,
  fetchSuggestions,
  getSuggestions,
  isSuggestionsLoading,
} from "$lib/stores/suggestions.svelte";
import {
  type ActivityGroupRange,
  activityGroupSummary,
  groupActivityRuns,
  isActivityGroup,
  isExplorationActivity,
} from "$lib/utils/activity-groups";
import { renderMarkdown } from "$lib/utils/markdown";

const TOOL_CALL_ROW_H = 14; // px — match walkthrough's compact tool-call rows

interface Props {
  prId: string | undefined;
}

let { prId }: Props = $props();

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
const chatCheckpoints = $derived(prId ? getCheckpoints(prId) : []);
const toolApprovals = $derived(prId ? getToolApprovals(prId) : []);
/** Index → checkpoint lookup for interleaving in the message loop. */
const checkpointByAfterIndex = $derived(new Map(chatCheckpoints.map((cp) => [cp.afterIndex, cp])));
/** Pending (un-responded) tool approvals, rendered after the last message. */
const pendingApprovals = $derived(toolApprovals.filter((a) => !a.responded));
const topLevelActivityGroupRanges = $derived.by(() =>
  visibleActivityGroupRanges(items, streamingTurnIds),
);
const topLevelActivityGroupByStart = $derived(
  new Map(topLevelActivityGroupRanges.map((range) => [range.start, range])),
);
const topLevelActivityGroupMemberIndices = $derived.by(() => {
  const indices = new Set<number>();
  for (const range of topLevelActivityGroupRanges) {
    for (let i = range.start + 1; i < range.end; i++) indices.add(i);
  }
  return indices;
});

const streamingTurnId = $derived(
  items.findLast(
    (i): i is Extract<typeof i, { kind: "message" }> =>
      i.kind === "message" && i.role === "assistant" && i.isStreaming,
  )?.turnId,
);
const streamingActivities = $derived(
  streamingTurnId
    ? items.filter(
        (i): i is Extract<typeof i, { kind: "activity" }> =>
          i.kind === "activity" && i.turnId === streamingTurnId && !i.subagentInvocationId,
      )
    : [],
);
const streamingActivityEntries = $derived(groupActivityRuns(streamingActivities));
const latestStreamingActivityEntry = $derived(streamingActivityEntries.at(-1));
const recentToolCalls = $derived(streamingActivities.slice(-2));

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
// actually be visible — chat has no items yet for this PR.
$effect(() => {
  if (!prId) return;
  if (items.length > 0) return;
  if (getSuggestions(prId) !== null) return;
  void fetchSuggestions(prId);
});

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

function nestedActivitiesFor(invocationId: string) {
  return items.filter(
    (i): i is Extract<typeof i, { kind: "activity" }> =>
      i.kind === "activity" && i.subagentInvocationId === invocationId,
  );
}

function groupedNestedActivitiesFor(invocationId: string) {
  return groupActivityRuns(nestedActivitiesFor(invocationId));
}

type ActivityItem = Extract<(typeof items)[number], { kind: "activity" }>;

function visibleActivityGroupRanges(
  sourceItems: typeof items,
  activeTurnIds: Set<string>,
): ActivityGroupRange<ActivityItem>[] {
  const ranges: ActivityGroupRange<ActivityItem>[] = [];
  let start = -1;
  let current: ActivityItem[] = [];

  const flush = (end: number): void => {
    if (start < 0 || current.length === 0) return;
    ranges.push({
      start,
      end,
      group: { category: "exploring", items: current },
    });
    start = -1;
    current = [];
  };

  sourceItems.forEach((item, index) => {
    if (
      item.kind === "activity" &&
      !item.subagentInvocationId &&
      !(item.turnId && activeTurnIds.has(item.turnId)) &&
      isExplorationActivity(item)
    ) {
      if (start < 0) start = index;
      current.push(item);
      return;
    }

    flush(index);
  });

  flush(sourceItems.length);
  return ranges;
}

function handleSuggestion(text: string): void {
  if (!prId || isStreaming) return;
  sendChatMessage({ prId, message: text });
}

function handleApprovePlan(planId: string): void {
  if (!prId) return;
  void approvePlanAction(prId, planId);
}

function handleRejectPlan(planId: string): void {
  if (!prId) return;
  void rejectPlanAction(prId, planId);
}
</script>

<Conversation
  resetKey={prId}
  innerClass="min-h-0"
>
  {#if items.length === 0 && !error}
    <ConversationEmptyState
      title="Ask the agent about this pull request"
      description="The agent runs inside the PR's worktree and can read the code, propose fixes, and commit them on a working branch."
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
    <ConversationContent class="gap-2 px-2.5 py-3">
      {#each items as item, itemIdx (item.id)}
        {#if topLevelActivityGroupMemberIndices.has(itemIdx)}
          <!-- Rendered by the grouped activity row at this run's start. -->
        {:else if topLevelActivityGroupByStart.has(itemIdx)}
          {@const range = topLevelActivityGroupByStart.get(itemIdx)}
          {#if range}
            <ToolActivityGroup items={range.group.items} />
          {/if}
        {:else if item.kind === 'activity'}
          <!-- Skip nested sub-agent tool calls — they render
               inside their SubagentInvocation card. Also fold
               active-turn tool calls into the dot-matrix
               indicator below. -->
          {#if !item.subagentInvocationId && !(item.turnId && streamingTurnIds.has(item.turnId))}
            <div class="tool-line">
              <span class="tool-bullet">&rsaquo;</span>
              {#key item.summary}
                <ToolActivityReveal class="tool-text">{item.summary}</ToolActivityReveal>
              {/key}
            </div>
          {/if}
        {:else if item.kind === 'task-list'}
          <!-- Rendered exclusively in the Queue dock. -->
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
                  {#each groupedNestedActivitiesFor(item.id) as entry, entryIdx (isActivityGroup(entry) ? `group-${entry.items[0]?.id ?? entryIdx}` : entry.id)}
                    {#if isActivityGroup(entry)}
                      <ToolActivityGroup
                        items={entry.items}
                        active={item.status === 'running'}
                        defaultOpen={false}
                        class="mb-1"
                      />
                    {:else}
                      <div class="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                        <span class="font-semibold text-muted-foreground/60">&rsaquo;</span>
                        {#key entry.summary}
                          <ToolActivityReveal class="flex-1 min-w-0 break-words">{entry.summary}</ToolActivityReveal>
                        {/key}
                      </div>
                    {/if}
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
                <div class="mt-2 flex items-start gap-1.5 rounded bg-muted/60 border-l-2 border-muted-foreground px-2 py-1.5 text-xs text-muted-foreground" role="alert">
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
      {#if latestStreamingActivityEntry && isActivityGroup(latestStreamingActivityEntry)}
        <div class="chat-tool-calls">
          <div class="chat-tool-call" style="top: 0px">
            <span class="chat-tool-call-tool">
              <Shimmer active={true}>Exploring</Shimmer>
            </span>
            <span class="chat-tool-call-desc">{activityGroupSummary(latestStreamingActivityEntry.items)}</span>
          </div>
        </div>
      {:else if recentToolCalls.length > 0}
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
          and authenticate, then select your CLI agent in <a href="/settings" class="error-link">Settings</a>.
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

<style>
  /* Streaming indicator — dot matrix + last-2 tool calls sit below the
     last message during a streaming turn. */
  .streaming-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 10px 14px;
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

  :global(.tool-text) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: color-mix(in srgb, var(--color-text-muted) 72%, transparent);
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
</style>
