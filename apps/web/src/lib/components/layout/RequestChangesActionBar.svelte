<script lang="ts">
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import ChevronDown from "phosphor-svelte/lib/CaretDown";
import ChatCircle from "phosphor-svelte/lib/ChatCircle";
import Check from "phosphor-svelte/lib/Check";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import Send from "phosphor-svelte/lib/PaperPlaneRight";
import FileEdit from "phosphor-svelte/lib/PencilSimple";
import Sparkles from "phosphor-svelte/lib/Sparkle";
import XCircle from "phosphor-svelte/lib/XCircle";
import { Shimmer } from "$lib/components/ai/shimmer";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
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
  getRcCanComment,
  getRcOnApprove,
  getRcOnComment,
  getRcOnGenerateChanges,
  getRcOnSubmitReview,
  getRcSelectedCount,
  getRcSubmitting,
} from "$lib/stores/rcActions.svelte";

const pr = $derived(getSelectedPr());
const rcSubmitting = $derived(getRcSubmitting());
const rcSelectedCount = $derived(getRcSelectedCount());
const rcCanComment = $derived(getRcCanComment());
const rcApproveBlockerSummary = $derived(getRcApproveBlockerSummary());
const chatStreaming = $derived(pr ? isChatStreaming(pr.id) : false);

let rcGenerating = $state(false);

$effect(() => {
  if (!chatStreaming) rcGenerating = false;
});

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
</script>

{#snippet commentPill()}
  <!-- Plain COMMENT review: pushes line comments + selected walkthrough
       issues to GitHub without approving or requesting changes. This is the
       only review event GitHub permits on your own PR, so it's surfaced for
       authors and reviewers alike. -->
  <GlassPill
    variant="muted"
    disabled={rcSubmitting !== null || !rcCanComment}
    onclick={() => getRcOnComment()()}
    title={!rcCanComment
      ? "Add comments or select walkthrough issues first"
      : "Post comments to GitHub without approving or requesting changes"}
  >
    <ChatCircle size={16} weight="regular" />
    {rcSubmitting === "comment" ? "Posting…" : "Comment"}
  </GlassPill>
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
      onclick={() => { rcGenerating = true; getRcOnGenerateChanges()(); }}
      title={rcSelectedCount === 0
        ? "Select at least one issue to ask the agent to address"
        : rcGenerating
          ? "Agent is generating changes…"
          : "Open the chat panel and ask the agent to address the selected issues as commits"}
    >
      <Sparkles size={16} weight="fill" />
      <Shimmer active={rcSubmitting === null && rcSelectedCount > 0}>
        {rcGenerating ? "Generating changes…" : "Generate changes"}
      </Shimmer>
    </GlassPill>

    {#if isPrOwner && pr}
      <!-- Owner view — GitHub rejects Approve / Request Changes on your own
           PR, so instead of that pair we surface the actions a coder actually
           needs here: post review comments (the one review event allowed on
           your own PR), toggle draft state, merge, and close. -->
      {@render commentPill()}
      {#if pr.isDraft}
        <GlassPill
          variant="accent"
          disabled={ownerSubmitting !== null}
          onclick={() => runOwnerAction("ready-for-review")}
          title="Mark this draft as ready for review"
        >
          <Send size={16} weight="fill" />
          {ownerSubmitting === "ready-for-review" ? "Marking ready…" : "Ready for review"}
        </GlassPill>
      {:else}
        <GlassPill
          disabled={ownerSubmitting !== null}
          onclick={() => runOwnerAction("convert-to-draft")}
          title="Move this PR back to draft state"
        >
          <FileEdit size={16} weight="fill" />
          {ownerSubmitting === "convert-to-draft" ? "Converting…" : "Convert to draft"}
        </GlassPill>
      {/if}

      {#if mergeEligibility?.canMerge && pr.status === "open"}
        <!-- Eligibility resolves asynchronously, so the merge pill lands a
             beat after the rest of the bar. Fade it in instead of popping. -->
        <span
          class="pill-wrap"
          in:gsapFadeY={{ duration: tokens.quick, y: 4 }}
          out:gsapFade={{ duration: tokens.snap }}
        >
        <div
          class="glass-pill glass-pill--success merge-pill"
          class:is-disabled={ownerSubmitting !== null || mergeSubmitting !== null}
        >
          <button
            type="button"
            class="merge-pill-main"
            disabled={ownerSubmitting !== null || mergeSubmitting !== null}
            onclick={() => runMerge("merge")}
            title="Merge this pull request"
          >
            <GitMerge size={16} weight="fill" />
            {mergeSubmitting === "merge" ? "Merging…" : "Merge"}
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
                <ChevronDown size={16} />
              </button>
            </PopoverTrigger>
            <PopoverContent class="w-56 p-1" align="end" side="top">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                onclick={() => runMerge("merge")}
              >
                <GitMerge size={12} weight="fill" />
                Create a merge commit
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                onclick={() => runMerge("squash")}
              >
                <GitMerge size={12} weight="fill" />
                Squash and merge
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                onclick={() => runMerge("rebase")}
              >
                <GitMerge size={12} weight="fill" />
                Rebase and merge
              </button>
            </PopoverContent>
          </Popover>
        </div>
        </span>
      {/if}

      <GlassPill
        variant="danger"
        disabled={ownerSubmitting !== null}
        onclick={() => runOwnerAction("close")}
        title="Close this pull request without merging"
      >
        <XCircle size={16} weight="fill" />
        {ownerSubmitting === "close" ? "Closing…" : "Close PR"}
      </GlassPill>
    {:else}
      <!-- Not the PR owner → a reviewer. Review mode is derived from identity
           (see getReviewModeForPr), so "not owner" is exactly "reviewer". One
           "Submit Review" posts everything in a single GitHub review: the line
           comments always go up, and it requests changes when walkthrough
           issues are selected (otherwise it's a plain comment review). Approve
           stays a distinct action. -->
      <GlassPill
        variant="accent"
        disabled={rcSubmitting !== null || !rcCanComment}
        onclick={() => getRcOnSubmitReview()()}
        title={!rcCanComment
          ? "Add comments or select walkthrough issues first"
          : "Submit your review — posts your comments, and requests changes if any issues are selected"}
      >
        <ArrowUp size={16} weight="regular" />
        {rcSubmitting !== null ? "Submitting…" : "Submit Review"}
      </GlassPill>
      <GlassPill
        variant="success"
        disabled={rcSubmitting !== null}
        onclick={() => getRcOnApprove()()}
        title={rcApproveBlockerSummary
          ? `Approve this pull request (${rcApproveBlockerSummary} still open)`
          : "Approve this pull request on GitHub"}
      >
        <Check size={16} weight="regular" />
        {rcSubmitting === "approve" ? "Approving…" : "Approve"}
      </GlassPill>
    {/if}
  </div>
</div>

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

  .merge-pill-main:disabled,
  .merge-pill-chevron:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
</style>
