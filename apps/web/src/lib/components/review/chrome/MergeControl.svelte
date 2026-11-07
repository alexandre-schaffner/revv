<script lang="ts">
// Merging one PR: the merge pill with its strategy menu, the stack sheet when
// the PR sits in a stack, and the confirmation a merge needs (another
// author's PR, or a merge that bypasses branch protection).
import type { MergeMethod } from "@revv/shared";
import { isOpenLayer, loginsMatch } from "@revv/shared";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import ShieldWarning from "phosphor-svelte/lib/ShieldWarning";
import Stack from "phosphor-svelte/lib/Stack";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getConversation } from "$lib/stores/conversation.svelte";
import { useMergeEligibility, viewerMayMerge } from "$lib/stores/merge-eligibility.svelte";
import { getPrById, mergePr } from "$lib/stores/prs.svelte";
import { openStackMergeSheet } from "$lib/stores/stack-merge.svelte";
import { getLayer, getStack, getStackRequest } from "$lib/stores/stacks.svelte";
import MergeConfirmDialog from "./MergeConfirmDialog.svelte";
import { type MergeGate, mergeGate } from "./merge-blocker";

interface Props {
  prId: string;
  /** Another PR action is running. */
  disabled?: boolean;
}

let { prId, disabled = false }: Props = $props();

const pr = $derived(getPrById(prId));
const isPrOwner = $derived(!!pr && loginsMatch(pr.authorLogin, getCurrentUserLogin()));

const eligibility = useMergeEligibility(
  () => prId,
  () => viewerMayMerge(prId),
);
const mergeEligibility = $derived(eligibility.current);
const shown = $derived(pr?.status === "open" && eligibility.viewerCanMerge);

const conversation = $derived.by(() => {
  const request = getConversation(prId).request;
  return request.status === "ok" ? request.data : null;
});

// Repos disable merge strategies freely (squash-only is common); GitHub
// answers a disabled strategy with a 405, so the pill offers exactly what
// `allowedMethods` reports, in GitHub's own order of preference.
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
  return MERGE_METHOD_OPTIONS.filter((m) => allowed.includes(m.method));
});
const primaryMerge = $derived(mergeOptions[0] ?? MERGE_COMMIT);

const stackLayer = $derived(getLayer(prId));
const stack = $derived(getStack(prId));
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
const stackUnknownReason = $derived.by(() => {
  if (!pr?.stack || pr.stack.position <= 1 || stackLayer) return null;
  return getStackRequest(prId).status === "error"
    ? "Couldn't read the stack this PR sits in"
    : "Reading the stack this PR sits in…";
});

const mergeGateNow = $derived.by((): MergeGate => {
  if (stackUnknownReason) return { kind: "blocked", reason: stackUnknownReason };
  if (!mergeEligibility) return { kind: "open" };
  return mergeGate({
    mergeStateStatus: mergeEligibility.mergeStateStatus,
    reviewDecision: conversation?.reviewDecision ?? null,
    ciState: conversation?.ci?.state ?? null,
    canBypassProtections: mergeEligibility.canBypassProtections,
  });
});
const mergeBlockedReason = $derived(mergeGateNow.kind === "blocked" ? mergeGateNow.reason : null);
const bypassRule = $derived(mergeGateNow.kind === "bypass" ? mergeGateNow.rule : null);

let mergeSubmitting = $state<MergeMethod | null>(null);
let mergeMenuOpen = $state(false);
let mergeToConfirm = $state<MergeOption | null>(null);
let mergeConfirmOpen = $state(false);
const mergeDisabled = $derived(disabled || mergeSubmitting !== null || mergeBlockedReason !== null);

/** The author merges a plain merge of their own PR at once; anything else confirms first. */
function requestMerge(option: MergeOption): void {
  mergeMenuOpen = false;
  if (isPrOwner && bypassRule === null) {
    void runMerge(option.method);
    return;
  }
  mergeToConfirm = option;
  mergeConfirmOpen = true;
}

async function runMerge(method: MergeMethod): Promise<void> {
  if (mergeSubmitting !== null) return;
  mergeSubmitting = method;
  mergeMenuOpen = false;
  try {
    await mergePr(prId, method);
  } finally {
    mergeSubmitting = null;
  }
}
</script>

{#if shown}
  <!-- Eligibility resolves asynchronously, so the merge pill lands a
       beat after the rest of the bar. Fade it in instead of popping. -->
  <span
    class="pill-wrap"
    in:gsapFadeY={{ duration: tokens.quick, y: 4 }}
    out:gsapFade={{ duration: tokens.snap }}
  >
  {#if openBelow && stackLayer}
    <GlassPill
      variant="success"
      {disabled}
      onclick={() => openStackMergeSheet(prId)}
      title={mergeThroughTitle}
      aria-haspopup="dialog"
    >
      <Stack size={16} />
      Merge through #{stackLayer.number}…
    </GlassPill>
  {:else}
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
      title={mergeBlockedReason ??
        (bypassRule
          ? `${bypassRule}. You can bypass branch protections and merge anyway.`
          : primaryMerge.menuLabel)}
    >
      {#if bypassRule}<ShieldWarning size={16} />{:else}<GitMerge size={16} />{/if}
      {#if mergeSubmitting === primaryMerge.method}
        Merging…
      {:else}
        {primaryMerge.label}{bypassRule ? " (bypass rules)" : ""}
      {/if}
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
          {#if openAbove}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
              title="Merge this layer and the ones above it, bottom-up"
              onclick={() => {
                mergeMenuOpen = false;
                openStackMergeSheet(prId);
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

{#if pr}
  <MergeConfirmDialog
    open={mergeConfirmOpen}
    prNumber={pr.externalId}
    authorLogin={isPrOwner ? null : pr.authorLogin}
    targetBranch={pr.targetBranch}
    methodLabel={(mergeToConfirm ?? primaryMerge).menuLabel}
    {bypassRule}
    onOpenChange={(open) => (mergeConfirmOpen = open)}
    onConfirm={() => {
      mergeConfirmOpen = false;
      if (mergeToConfirm) void runMerge(mergeToConfirm.method);
    }}
  />
{/if}

<style>
  .pill-wrap {
    display: inline-flex;
    align-items: center;
  }

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
  }
</style>
