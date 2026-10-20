<script lang="ts">
import { isOpenLayer, loginsMatch, type MergeEligibility, type MergeMethod } from "@revv/shared";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Check from "phosphor-svelte/lib/Check";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import PaperPlaneRight from "phosphor-svelte/lib/PaperPlaneRight";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import PenNib from "phosphor-svelte/lib/PenNib";
import Stack from "phosphor-svelte/lib/Stack";
import XCircle from "phosphor-svelte/lib/XCircle";
import { untrack } from "svelte";
import { Shimmer } from "$lib/components/ai/shimmer";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import { getConversation } from "$lib/stores/conversation.svelte";
import {
  askMergeEligibility,
  getMergeEligibilityRequest,
} from "$lib/stores/merge-eligibility.svelte";
import {
  closePr,
  convertPrToDraft,
  getSelectedPr,
  markPrReadyForReview,
  mergePr,
} from "$lib/stores/prs.svelte";
import {
  getReviewBarApproveBlockerSummary,
  getReviewBarCanComment,
  getReviewBarOnApprove,
  getReviewBarOnComment,
  getReviewBarOnGenerateChanges,
  getReviewBarOnSubmitReview,
  getReviewBarSelectedCount,
  getReviewBarSubmitting,
} from "$lib/stores/reviewBar.svelte";
import { openStackMergeSheet } from "$lib/stores/stack-merge.svelte";
import { getLayer, getStack, getStackRequest } from "$lib/stores/stacks.svelte";
import { mergeBlocker } from "$lib/utils/merge-blocker";
import MergeConfirmDialog from "./MergeConfirmDialog.svelte";

const pr = $derived(getSelectedPr());
const rcSubmitting = $derived(getReviewBarSubmitting());
const rcSelectedCount = $derived(getReviewBarSelectedCount());
const rcCanComment = $derived(getReviewBarCanComment());
const rcApproveBlockerSummary = $derived(getReviewBarApproveBlockerSummary());
const chatStreaming = $derived(pr ? isChatStreaming(pr.id) : false);

let rcGenerating = $state(false);

$effect(() => {
  if (!chatStreaming) rcGenerating = false;
});

const currentUserLogin = $derived(getCurrentUserLogin());
const isPrOwner = $derived(!!pr && loginsMatch(pr.authorLogin, currentUserLogin));
// Draft toggle, merge, and close only make sense on an open PR; a closed or
// merged one keeps just the submit-review pill (GitHub has no reopen path here).
const isPrOpen = $derived(pr?.status === "open");

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

let mergeSubmitting = $state<string | null>(null);
let mergeMenuOpen = $state(false);
/** The strategy a reviewer picked, waiting on their confirmation. */
let mergeToConfirm = $state<MergeOption | null>(null);
let mergeConfirmOpen = $state(false);

// The viewer's own standing verdict, from the Conversation tab's snapshot. A
// later "request changes" or a stale-review dismissal brings Approve back.
const conversation = $derived.by(() => {
  const request = pr ? getConversation(pr.id).request : null;
  return request?.status === "ok" ? request.data : null;
});
const viewerApproved = $derived(
  conversation?.reviewers.some(
    (r) =>
      r.kind === "user" &&
      loginsMatch(r.actor.login, conversation.viewerLogin) &&
      r.verdict === "approved",
  ) ?? false,
);

// Mergeability moves with a new head, the review decision, and CI, so a
// change in any of them asks again. The ask is keyed on these primitives
// only: the PR and conversation objects are replaced by every store update
// (a CI poll, an SSE refresh, the cached snapshot then the fresh read), and
// depending on them, or on when the conversation was read, re-asked GitHub on
// each one.
const mergeAskPrId = $derived(pr?.id ?? null);
const mergeAskHeadSha = $derived(pr?.headSha ?? null);
const mayMerge = $derived(isPrOwner || viewerApproved);
// Asked once the conversation has answered (its cached snapshot is
// near-instant), so its review decision and CI arriving don't re-ask straight
// after. A failed read counts: the merge pill mustn't hinge on it.
const conversationKnown = $derived.by(() => {
  const status = pr ? getConversation(pr.id).request.status : "idle";
  return status === "ok" || status === "error";
});
const conversationReviewDecision = $derived(conversation?.reviewDecision ?? null);
const conversationCiState = $derived(conversation?.ci?.state ?? null);
const mergeAskKey = $derived(
  mergeAskPrId && mayMerge && conversationKnown
    ? `${mergeAskHeadSha} ${conversationReviewDecision} ${conversationCiState}`
    : null,
);
$effect(() => {
  const prId = mergeAskPrId;
  const key = mergeAskKey;
  if (prId && key !== null) untrack(() => askMergeEligibility(prId, key));
});
const mergeEligibility = $derived.by((): MergeEligibility | null => {
  if (!mergeAskPrId || mergeAskKey === null) return null;
  const request = getMergeEligibilityRequest(mergeAskPrId);
  return request.status === "ok" ? request.data : null;
});

// Repos disable merge strategies freely (squash-only is common); GitHub
// answers a disabled strategy with a 405, so the pill offers exactly what
// `allowedMethods` reports, in GitHub's own order of preference. An empty
// list can only mean a stale/failed eligibility read — fall back to all three
// rather than stranding the author with no merge button.
interface MergeOption {
  method: MergeMethod;
  label: string;
  menuLabel: string;
}

const MERGE_COMMIT: MergeOption = {
  method: "merge",
  label: "Merge",
  menuLabel: "Create a merge commit",
};
const MERGE_METHOD_OPTIONS: MergeOption[] = [
  MERGE_COMMIT,
  { method: "squash", label: "Squash and merge", menuLabel: "Squash and merge" },
  { method: "rebase", label: "Rebase and merge", menuLabel: "Rebase and merge" },
];

const mergeOptions = $derived.by(() => {
  const allowed = mergeEligibility?.allowedMethods ?? [];
  if (allowed.length === 0) return MERGE_METHOD_OPTIONS;
  return MERGE_METHOD_OPTIONS.filter((m) => allowed.includes(m.method));
});
const primaryMerge = $derived(mergeOptions[0] ?? MERGE_COMMIT);

// A stacked PR targets the branch of the layer below it, so merging it alone
// while that layer is open lands it there, not in the stack's base. Such a
// layer only offers "Merge through #N…", which merges the stack bottom-up.
// The review page reads the stack.
const stackLayer = $derived(pr ? getLayer(pr.id) : null);
const stack = $derived(pr ? getStack(pr.id) : null);
const openBelow = $derived(
  stack && stackLayer
    ? stack.layers.some((l) => l.position < stackLayer.position && isOpenLayer(l))
    : false,
);
const openAbove = $derived(
  stack && stackLayer
    ? stack.layers.some((l) => l.position > stackLayer.position && isOpenLayer(l))
    : false,
);
const mergeThroughTitle = $derived(
  stack && stackLayer
    ? `This PR targets ${stackLayer.baseRef}, the layer below it. Merging it alone would land it there, not in ${stack.baseRefName}; merge the stack through here instead.`
    : "",
);
// Until the stack read lands, or when it fails, a layer above the bottom
// can't tell whether the ones below it are still open, so it isn't offered a
// plain merge. The bottom layer sits on the base and may merge alone.
const stackUnknownReason = $derived.by(() => {
  if (!pr?.stack || pr.stack.position <= 1 || stackLayer) return null;
  return getStackRequest(pr.id).status === "error"
    ? "Couldn't read the stack this PR sits in"
    : "Reading the stack this PR sits in…";
});

const mergeBlockedReason = $derived(
  stackUnknownReason ??
    (mergeEligibility
      ? mergeBlocker({
          mergeStateStatus: mergeEligibility.mergeStateStatus,
          reviewDecision: conversationReviewDecision,
          ciState: conversationCiState,
        })
      : null),
);
const mergeDisabled = $derived(
  ownerSubmitting !== null || mergeSubmitting !== null || mergeBlockedReason !== null,
);

/**
 * The author merges their own PR straight away. Anyone else confirms first:
 * merging someone else's work is never a single press.
 */
function requestMerge(option: MergeOption): void {
  mergeMenuOpen = false;
  if (isPrOwner) {
    void runMerge(option.method);
    return;
  }
  mergeToConfirm = option;
  mergeConfirmOpen = true;
}

async function runMerge(method: MergeMethod): Promise<void> {
  if (!pr || mergeSubmitting !== null) return;
  mergeSubmitting = method;
  mergeMenuOpen = false;
  try {
    await mergePr(pr.id, method);
  } finally {
    mergeSubmitting = null;
  }
}
</script>

{#snippet mergeControl()}
  {#if mergeEligibility?.canMerge && isPrOpen}
    <!-- Eligibility resolves asynchronously, so the merge pill lands a
         beat after the rest of the bar. Fade it in instead of popping. -->
    <span
      class="pill-wrap"
      in:gsapFadeY={{ duration: tokens.quick, y: 4 }}
      out:gsapFade={{ duration: tokens.snap }}
    >
    {#if openBelow && pr && stackLayer}
      <GlassPill
        variant="success"
        disabled={ownerSubmitting !== null}
        onclick={() => openStackMergeSheet(pr.id)}
        title={mergeThroughTitle}
        aria-haspopup="dialog"
      >
        <Stack size={16} />
        Merge through #{stackLayer.number}…
      </GlassPill>
    {:else}
    <!-- GitHub would refuse the merge: keep the pill in place, disabled,
         with the reason on hover rather than letting a click fail. -->
    <div
      class="glass-pill glass-pill--success merge-pill"
      data-glass
      class:is-disabled={mergeDisabled}
      title={mergeBlockedReason ?? undefined}
    >
      <button
        type="button"
        class="merge-pill-main"
        disabled={mergeDisabled}
        onclick={() => requestMerge(primaryMerge)}
        title={mergeBlockedReason ?? primaryMerge.menuLabel}
      >
        <GitMerge size={16} />
        {mergeSubmitting === primaryMerge.method ? "Merging…" : primaryMerge.label}
      </button>
      {#if mergeOptions.length > 1 || openAbove}
        <Popover bind:open={mergeMenuOpen}>
          <PopoverTrigger>
            <button
              type="button"
              class="merge-pill-chevron"
              disabled={mergeDisabled}
              aria-label="Merge options"
              title="Choose merge strategy"
            >
              <CaretDown size={16} />
            </button>
          </PopoverTrigger>
          <PopoverContent class="w-56 p-1" align="end" side="top">
            {#each mergeOptions as option (option.method)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                onclick={() => requestMerge(option)}
              >
                <GitMerge size={12} />
                {option.menuLabel}
              </button>
            {/each}
            {#if openAbove && pr}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                title="Merge this layer and the ones above it, bottom-up"
                onclick={() => {
                  mergeMenuOpen = false;
                  openStackMergeSheet(pr.id);
                }}
              >
                <Stack size={12} />
                Merge stack…
              </button>
            {/if}
          </PopoverContent>
        </Popover>
      {/if}
    </div>
    {/if}
    </span>
  {/if}
{/snippet}

<div
  class="actions-float"
  in:gsapFadeY={{ duration: tokens.quick, y: 8 }}
  out:gsapFade={{ duration: tokens.snap }}
>
  <div class="actions-row" role="toolbar" aria-label="Review actions">
    <GlassPill
      variant="muted"
      disabled={rcSubmitting !== null || rcSelectedCount === 0 || rcGenerating}
      onclick={() => { rcGenerating = true; getReviewBarOnGenerateChanges()(); }}
      title={rcSelectedCount === 0
        ? "Select at least one issue to ask the agent to address"
        : rcGenerating
          ? "Agent is generating changes…"
          : "Open the chat panel and ask the agent to address the selected issues as commits"}
    >
      <PenNib size={16} />
      <Shimmer active={rcSubmitting === null && rcSelectedCount > 0}>
        {rcGenerating ? "Generating changes…" : "Generate changes"}
      </Shimmer>
    </GlassPill>

    {#if isPrOwner && pr}
      <!-- Owner view — GitHub rejects Approve / Request Changes on your own
           PR, so instead of that pair we surface the actions a coder actually
           needs here: post review comments (the one review event allowed on
           your own PR), toggle draft state, merge, and close. -->
      <!-- A plain COMMENT review: pushes line comments + selected walkthrough
           issues without approving or requesting changes. Labelled "Submit
           review", not "Comment", so it doesn't read as a twin of the
           Conversation tab's composer, which posts a top-level PR comment. -->
      <GlassPill
        variant="muted"
        disabled={rcSubmitting !== null || !rcCanComment}
        onclick={() => getReviewBarOnComment()()}
        title={!rcCanComment
          ? "Add comments or select walkthrough issues first"
          : "Post your line comments and selected issues to GitHub as a review"}
      >
        <ArrowUp size={16} />
        {rcSubmitting === "comment" ? "Submitting…" : "Submit review"}
      </GlassPill>
      {#if isPrOpen && pr.isDraft}
        <GlassPill
          variant="accent"
          disabled={ownerSubmitting !== null}
          onclick={() => runOwnerAction("ready-for-review")}
          title="Mark this draft as ready for review"
        >
          <PaperPlaneRight size={16} />
          {ownerSubmitting === "ready-for-review" ? "Marking ready…" : "Ready for review"}
        </GlassPill>
      {:else if isPrOpen}
        <GlassPill
          disabled={ownerSubmitting !== null}
          onclick={() => runOwnerAction("convert-to-draft")}
          title="Move this PR back to draft state"
        >
          <PencilSimple size={16} />
          {ownerSubmitting === "convert-to-draft" ? "Converting…" : "Convert to draft"}
        </GlassPill>
      {/if}

      {@render mergeControl()}

      {#if isPrOpen}
        <GlassPill
          variant="danger"
          disabled={ownerSubmitting !== null}
          onclick={() => runOwnerAction("close")}
          title="Close this pull request without merging"
        >
          <XCircle size={16} />
          {ownerSubmitting === "close" ? "Closing…" : "Close PR"}
        </GlassPill>
      {/if}
    {:else}
      <!-- Not the PR owner → a reviewer. Review mode is derived from identity
           (see getReviewModeForPr), so "not owner" is exactly "reviewer". One
           "Submit review" posts everything in a single GitHub review: the line
           comments always go up, and it requests changes when walkthrough
           issues are selected (otherwise it's a plain comment review). Approve
           stays a distinct action. -->
      <GlassPill
        variant="accent"
        disabled={rcSubmitting !== null || !rcCanComment}
        onclick={() => getReviewBarOnSubmitReview()()}
        title={!rcCanComment
          ? "Add comments or select walkthrough issues first"
          : "Submit your review — posts your comments, and requests changes if any issues are selected"}
      >
        <ArrowUp size={16} />
        {rcSubmitting !== null ? "Submitting…" : "Submit review"}
      </GlassPill>
      <!-- Once your approval stands, Approve stays put as a spent "Approved"
           and merging, when you're allowed to, is its own pill beside it,
           behind a confirmation: a second press on Approve never merges. -->
      {#if viewerApproved}
        <GlassPill variant="success" disabled title="You approved this pull request">
          <Check size={16} />
          Approved
        </GlassPill>
        {@render mergeControl()}
      {:else}
        <GlassPill
          variant="success"
          disabled={rcSubmitting !== null}
          onclick={() => getReviewBarOnApprove()()}
          title={rcApproveBlockerSummary
            ? `Approve this pull request (${rcApproveBlockerSummary} still open)`
            : "Approve this pull request on GitHub"}
        >
          <Check size={16} />
          {rcSubmitting === "approve" ? "Approving…" : "Approve"}
        </GlassPill>
      {/if}
    {/if}
  </div>
</div>

{#if pr && !isPrOwner}
  <MergeConfirmDialog
    open={mergeConfirmOpen}
    prNumber={pr.externalId}
    authorLogin={pr.authorLogin}
    targetBranch={pr.targetBranch}
    methodLabel={(mergeToConfirm ?? primaryMerge).menuLabel}
    onOpenChange={(open) => (mergeConfirmOpen = open)}
    onConfirm={() => {
      mergeConfirmOpen = false;
      if (mergeToConfirm) void runMerge(mergeToConfirm.method);
    }}
  />
{/if}

<style>
  /* The bar wrapper now uses the shared `.actions-float` / `.actions-row`
     primitives from `app.css`. Only locally-scoped pieces (the merge split-
     button shape, the async-eligibility fade wrapper) remain here. */
  .pill-wrap {
    display: inline-flex;
    align-items: center;
  }

  /* Merge split-button: single pill shell with transparent inner buttons so the
     wrapper's `.glass-pill` border and radius create the shape. */
  .merge-pill {
    padding: 0;
    overflow: hidden;
  }

  /* Tactile press parity with every other GlassPill. The wrapper's own
     `:active` rule can't fire because the inner buttons are what the user
     clicks. `:has()` is supported in the Tauri WebKit baseline. */
  .merge-pill:has(.merge-pill-main:active:not(:disabled)),
  .merge-pill:has(.merge-pill-chevron:active:not(:disabled)) {
    transform: scale(0.97);
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

  /* The wrapper's `.is-disabled` already dims the pill; dimming the buttons
     too would compound to near-invisible. */
  .merge-pill-main:disabled,
  .merge-pill-chevron:disabled {
    cursor: not-allowed;
  }
</style>
