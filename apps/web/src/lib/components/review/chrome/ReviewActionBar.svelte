<script lang="ts">
import { loginsMatch, type ReviewAction } from "@revv/shared";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Check from "phosphor-svelte/lib/Check";
import PaperPlaneRight from "phosphor-svelte/lib/PaperPlaneRight";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import PenNib from "phosphor-svelte/lib/PenNib";
import XCircle from "phosphor-svelte/lib/XCircle";
import { isChatStreaming } from "$lib/chat/timeline.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Shimmer } from "$lib/components/ui/shimmer";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { viewerApproved } from "$lib/stores/merge-eligibility.svelte";
import { closePr, convertPrToDraft, getPrById, markPrReadyForReview } from "$lib/stores/prs.svelte";
import MergeControl from "./MergeControl.svelte";

interface Props {
  prId: string;
  submitting: ReviewAction | null;
  selectedCount: number;
  /** Anything to submit: selected walkthrough issues or pending line comments. */
  canComment: boolean;
  approveBlockerSummary: string;
  onGenerateChanges: () => void;
  onSubmitReview: () => void;
  onComment: () => void;
  onApprove: () => void;
}

let {
  prId,
  submitting,
  selectedCount,
  canComment,
  approveBlockerSummary,
  onGenerateChanges,
  onSubmitReview,
  onComment,
  onApprove,
}: Props = $props();

const pr = $derived(getPrById(prId));
// The agent is on a chat turn, the one Generate changes asked for or another.
const agentWorking = $derived(isChatStreaming(prId));

const isPrOwner = $derived(!!pr && loginsMatch(pr.authorLogin, getCurrentUserLogin()));
// Draft toggle, merge, and close only make sense on an open PR; a closed or
// merged one keeps just the submit-review pill (GitHub has no reopen path here).
const isPrOpen = $derived(pr?.status === "open");
const approved = $derived(viewerApproved(prId));

type OwnerAction = "convert-to-draft" | "ready-for-review" | "close";
let ownerSubmitting = $state<OwnerAction | null>(null);

async function runOwnerAction(action: OwnerAction): Promise<void> {
  if (ownerSubmitting !== null) return;
  ownerSubmitting = action;
  try {
    if (action === "convert-to-draft") await convertPrToDraft(prId);
    else if (action === "ready-for-review") await markPrReadyForReview(prId);
    else await closePr(prId);
  } finally {
    ownerSubmitting = null;
  }
}
</script>

<div
  class="actions-row"
  role="toolbar"
  aria-label="Review actions"
  in:gsapFadeY={{ duration: tokens.quick, y: 8 }}
  out:gsapFade={{ duration: tokens.snap }}
>
  <GlassPill
    variant="muted"
    disabled={submitting !== null || selectedCount === 0 || agentWorking}
    onclick={onGenerateChanges}
    title={selectedCount === 0
      ? "Select at least one issue to ask the agent to address"
      : agentWorking
        ? "Agent is generating changes…"
        : "Open the chat panel and ask the agent to address the selected issues as commits"}
  >
    <PenNib size={16} />
    <Shimmer active={submitting === null && selectedCount > 0}>
      {agentWorking ? "Generating changes…" : "Generate changes"}
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
      disabled={submitting !== null || !canComment}
      onclick={onComment}
      title={!canComment
        ? "Add comments or select walkthrough issues first"
        : "Post your line comments and selected issues to GitHub as a review"}
    >
      <ArrowUp size={16} />
      {submitting === "comment" ? "Submitting…" : "Submit review"}
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

    <MergeControl {prId} disabled={ownerSubmitting !== null} />

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
    <!-- One "Submit review" posts everything as a single GitHub review: the
         line comments always, and it requests changes when walkthrough
         issues are selected. Approve stays a separate action. -->
    <GlassPill
      variant="accent"
      disabled={submitting !== null || !canComment}
      onclick={onSubmitReview}
      title={!canComment
        ? "Add comments or select walkthrough issues first"
        : "Submit your review — posts your comments, and requests changes if any issues are selected"}
    >
      <ArrowUp size={16} />
      {submitting !== null ? "Submitting…" : "Submit review"}
    </GlassPill>
    {#if approved}
      <GlassPill variant="success" disabled title="You approved this pull request">
        <Check size={16} />
        Approved
      </GlassPill>
      <MergeControl {prId} />
    {:else}
      <GlassPill
        variant="success"
        disabled={submitting !== null}
        onclick={onApprove}
        title={approveBlockerSummary
          ? `Approve this pull request (${approveBlockerSummary} still open)`
          : "Approve this pull request on GitHub"}
      >
        <Check size={16} />
        {submitting === "approve" ? "Approving…" : "Approve"}
      </GlassPill>
    {/if}
  {/if}
</div>

