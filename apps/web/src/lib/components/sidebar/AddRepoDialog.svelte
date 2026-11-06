<script lang="ts">
import ArrowLeft from "phosphor-svelte/lib/ArrowLeft";
import CloudArrowDown from "phosphor-svelte/lib/CloudArrowDown";
import FolderOpen from "phosphor-svelte/lib/FolderOpen";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { gsapFade, gsapFadeY, gsapPress, tokens } from "$lib/motion";
import { fetchDefaultCloneBaseDir } from "$lib/repos/catalog.svelte";
import { readStored, STORAGE_KEYS, textCodec, writeStored } from "$lib/stores/persisted.svelte";
import AddRepoForm from "./AddRepoForm.svelte";
import LinkRepoForm from "./LinkRepoForm.svelte";
import RepoDialogHeader from "./RepoDialogHeader.svelte";

let {
  open = false,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
} = $props();

type View = "choose" | "clone" | "link";

let view = $state<View>("choose");
// Empty = "use the server's default base" (shown as the placeholder, fetched
// from the server). Only a user-chosen custom base is ever held here.
let cloneBasePath = $state("");

// Reset to the source chooser *before* the reopened modal paints. $effect.pre
// runs ahead of the dialog content's DOM update in the same flush, so when
// `open` flips true the content mounts already showing the chooser (hug-height)
// instead of painting the previous step's height for a frame and then resizing.
// On close we leave `view` alone so the exit animation keeps the current step.
$effect.pre(() => {
  if (!open) return;
  view = "choose";
  void fetchDefaultCloneBaseDir();
  cloneBasePath = readStored(STORAGE_KEYS.lastCloneBase, textCodec, null) ?? "";
});

function rememberCloneBase(path: string): void {
  cloneBasePath = path;
  // Persist only an explicit custom base; an empty value means "default", which
  // we never want to pin (it would survive a later server-default change).
  writeStored(STORAGE_KEYS.lastCloneBase, textCodec, path);
}
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content
    class={[
      'flex flex-col !gap-0 !p-0 sm:!max-w-[480px] overflow-hidden',
      // Only the clone view's list loads in, so only it takes a fixed height.
      view === 'clone' ? 'h-[min(580px,82vh)]' : 'max-h-[min(580px,82vh)]',
    ]}
    showCloseButton={false}
  >
    <Dialog.Header class="sr-only">
      <Dialog.Title>Add Repository</Dialog.Title>
      <Dialog.Description>Track a new GitHub repository in Revv.</Dialog.Description>
    </Dialog.Header>
    <div class="view-stack min-h-0 flex-1 p-5">
      {#if view === "choose"}
        <div
          class="source-chooser"
          in:gsapFadeY={{ y: 6, duration: tokens.quick }}
          out:gsapFade={{ duration: tokens.snap }}
        >
          <RepoDialogHeader title="Add Repository" meta="Sources" />

          <button type="button" class="source-row" onclick={() => (view = "clone")} use:gsapPress>
            <span class="source-icon"><CloudArrowDown size={17} /></span>
            <span class="source-body">
              <span class="source-title">Clone from GitHub</span>
              <span class="source-hint">Revv manages the clone</span>
            </span>
          </button>

          <button type="button" class="source-row" onclick={() => (view = "link")} use:gsapPress>
            <span class="source-icon"><FolderOpen size={17} /></span>
            <span class="source-body">
              <span class="source-title">Open Existing Clone</span>
              <span class="source-hint">You manage the clone</span>
            </span>
          </button>
        </div>
      {:else if view === "clone"}
        <div
          class="step-view"
          in:gsapFadeY={{ y: 6, duration: tokens.quick }}
          out:gsapFade={{ duration: tokens.snap }}
        >
          <button type="button" class="back-btn" onclick={() => (view = "choose")} use:gsapPress>
            <ArrowLeft size={12} />
            <span>Sources</span>
          </button>
          <AddRepoForm
            onClose={() => onOpenChange(false)}
            showLocation
            {cloneBasePath}
            onCloneBasePathChange={(path) => (cloneBasePath = path)}
            onCloneSuccess={rememberCloneBase}
          />
        </div>
      {:else}
        <div
          class="step-view"
          in:gsapFadeY={{ y: 6, duration: tokens.quick }}
          out:gsapFade={{ duration: tokens.snap }}
        >
          <button type="button" class="back-btn" onclick={() => (view = "choose")} use:gsapPress>
            <ArrowLeft size={12} />
            <span>Sources</span>
          </button>
          <LinkRepoForm onClose={() => onOpenChange(false)} />
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Every view layer shares one grid cell, so mid-transition the outgoing and
     incoming layers overlap and the modal's height is the max, never the sum. */
  .view-stack {
    display: grid;
  }

  .view-stack > * {
    grid-area: 1 / 1;
    min-width: 0;
    min-height: 0;
  }

  .source-chooser,
  .step-view {
    display: flex;
    min-height: 0;
    flex-direction: column;
  }

  .source-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 12px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--color-text-primary);
    cursor: pointer;
    text-align: left;
    transition:
      background var(--duration-instant) var(--ease-soft),
      border-color var(--duration-instant) var(--ease-soft);
  }

  .source-row:hover {
    background: var(--color-bg-tertiary);
  }

  .source-row:focus-visible {
    outline: none;
    border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
    box-shadow: 0 0 0 3px var(--color-input-focus-ring);
  }

  .source-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .source-row:hover .source-icon {
    color: var(--color-accent);
  }

  .source-body {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }

  .source-title {
    color: var(--color-text-primary);
    font-size: 12.5px;
    font-weight: 600;
  }

  .source-hint {
    color: var(--color-text-muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    height: 24px;
    margin: -2px 0 10px;
    padding: 0 6px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 11px;
    transition:
      background var(--duration-instant) var(--ease-soft),
      color var(--duration-instant) var(--ease-soft);
  }

  .back-btn:hover {
    background: var(--color-bg-tertiary);
    color: var(--color-text-primary);
  }

  .back-btn :global(svg) {
    transition: transform var(--duration-quick) var(--ease-out-expo);
  }

  .back-btn:hover :global(svg) {
    transform: translateX(-2px);
  }
</style>
