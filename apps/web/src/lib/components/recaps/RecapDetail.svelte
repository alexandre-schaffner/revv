<script lang="ts">
import type { ProjectRecap, RecapPeriod, RecapPrEntry, RecapThemeSummary } from "@revv/shared";
import ArrowLeft from "phosphor-svelte/lib/ArrowLeft";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Loader2 from "phosphor-svelte/lib/Spinner";
import CircleAlert from "phosphor-svelte/lib/WarningCircle";
import { Button } from "$lib/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import type { RecapStreamEntry } from "$lib/stores/recap-stream.svelte";
import { createStreamingBlockRenderer } from "$lib/utils/markdown";
import DotMatrixLoader from "./DotMatrixLoader.svelte";
import RecapBody from "./RecapBody.svelte";
import RecapHeroBig from "./RecapHeroBig.svelte";
import RecapSidebar from "./RecapSidebar.svelte";

interface Props {
  recap: ProjectRecap | null;
  loading: boolean;
  period?: RecapPeriod | undefined;
  onBack?: (() => void) | undefined;
  stream?: RecapStreamEntry | null | undefined;
}

let { recap, loading, period, onBack = undefined, stream = null }: Props = $props();

let thoughtsOpen = $state(false);
const renderThoughtBlocks = createStreamingBlockRenderer();

// Scroll-driven crossfade between the body-column big hero (RecapHeroBig)
// and the sidebar's small hero. `--shrink` (0..1) goes from 0 at the top
// to 1 once the user has scrolled past the big hero. Big hero opacity =
// 1 - shrink; small hero opacity = shrink. Below 960px the big hero is
// hidden and the small hero takes over immediately (locked to 1).
let recapPageEl = $state<HTMLElement | null>(null);

// Don't start the sidebar's fade-in until the big hero has scrolled
// noticeably off screen. SHRINK_START_PX is the dead zone above which
// scroll progress begins counting; SHRINK_RANGE_PX is the distance over
// which it ramps from 0 to 1.
const SHRINK_START_PX = 160;
const SHRINK_RANGE_PX = 120;
const MIN_MORPH_WIDTH_PX = 960;

function findScrollContainer(el: HTMLElement): HTMLElement | Window {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
    cur = cur.parentElement;
  }
  return window;
}

$effect(() => {
  if (!recapPageEl) return;
  const root = recapPageEl;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = matchMedia(`(min-width: ${MIN_MORPH_WIDTH_PX}px)`);

  const lock = (): void => {
    root.style.setProperty("--shrink", "1");
    const sidebar = root.querySelector<HTMLElement>(".side");
    if (sidebar) sidebar.removeAttribute("inert");
  };

  if (reducedMotion) {
    lock();
    return;
  }

  let container: HTMLElement | Window | null = null;
  let onScroll: (() => void) | null = null;

  const attach = (): void => {
    container = findScrollContainer(root);
    const target = container;
    // Cache the sidebar element once instead of querying on every scroll
    // tick. `null` when the recap hasn't loaded yet — the next onScroll
    // call after hydration will pick it up via the fallback lookup.
    let sidebar = root.querySelector<HTMLElement>(".side");
    let lastInert: boolean | null = null;
    onScroll = () => {
      const top = target instanceof Window ? window.scrollY : target.scrollTop;
      const next = Math.min(1, Math.max(0, (top - SHRINK_START_PX) / SHRINK_RANGE_PX));
      root.style.setProperty("--shrink", String(next));
      // Keep the sidebar out of the tab order and a11y tree while it's
      // visually hidden. Without this, screen reader users encounter
      // duplicate hero/stats/themes content (body hero + sidebar) that
      // sighted users only see one of at a time.
      if (!sidebar) sidebar = root.querySelector<HTMLElement>(".side");
      if (sidebar) {
        const shouldInert = next < 0.1;
        if (shouldInert !== lastInert) {
          sidebar.toggleAttribute("inert", shouldInert);
          lastInert = shouldInert;
        }
      }
    };
    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
  };

  const detach = (): void => {
    if (container && onScroll) container.removeEventListener("scroll", onScroll);
    container = null;
    onScroll = null;
  };

  const onWideChange = (e: MediaQueryListEvent): void => {
    if (e.matches) attach();
    else {
      detach();
      lock();
    }
  };

  if (wide.matches) attach();
  else lock();
  wide.addEventListener("change", onWideChange);

  return () => {
    detach();
    wide.removeEventListener("change", onWideChange);
  };
});

const effectivePeriod = $derived<RecapPeriod>(period ?? recap?.period ?? "daily");

// Stream entries win on conflict so the latest add_pr_entry shows immediately.
const mergedEntries = $derived.by<RecapPrEntry[]>(() => {
  const map = new Map<string, RecapPrEntry>();
  if (recap) {
    for (const e of recap.entries) map.set(e.prId, e);
  }
  if (stream) {
    for (const [prId, entry] of stream.entries) map.set(prId, entry);
  }
  return Array.from(map.values()).sort((a, b) => a.position - b.position);
});

// Same merge strategy for theme summaries — stream wins on conflict so a
// fresh set_theme_summary appears immediately even before the DB roundtrip.
const mergedThemeSummaries = $derived.by<RecapThemeSummary[]>(() => {
  const map = new Map<string, RecapThemeSummary>();
  if (recap) {
    for (const s of recap.themeSummaries) map.set(s.theme, s);
  }
  if (stream) {
    for (const [theme, summary] of stream.themeSummaries) map.set(theme, summary);
  }
  return Array.from(map.values());
});

const effectiveLede = $derived(stream?.lede || recap?.lede || "");

const liveRecap = $derived<ProjectRecap | null>(
  recap
    ? {
        ...recap,
        lede: effectiveLede,
        entries: mergedEntries,
        themeSummaries: mergedThemeSummaries,
      }
    : null,
);

const isGenerating = $derived(recap?.status === "generating");
const isComplete = $derived(recap?.status === "complete");
const isError = $derived(recap?.status === "error");
const isSuperseded = $derived(recap?.status === "superseded");

const hasAnyContent = $derived(effectiveLede.length > 0 || mergedEntries.length > 0);

const isEmptyComplete = $derived(
  !!recap && recap.status === "complete" && mergedEntries.length === 0,
);

const phaseLabel = $derived(
  stream ? stream.phaseMessage || phaseMessage(stream.phase) : "Starting recap…",
);
const thoughtText = $derived(stream?.thoughts ?? "");
const hasThoughtText = $derived(thoughtText.trim().length > 0);
const thoughtBlocks = $derived.by(() => renderThoughtBlocks(thoughtText));

function phaseMessage(phase: string): string {
  const labels: Record<string, string> = {
    analyzing: "Analyzing pull requests…",
    writing_lede: "Writing the lede…",
    categorizing: "Categorizing pull requests…",
    finalizing: "Finalizing recap…",
    connecting: "Connecting…",
  };
  return labels[phase] ?? "Generating recap…";
}

const COMPLETED_AT_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function formatCompletedAt(iso: string): string {
  return `${COMPLETED_AT_FMT.format(new Date(iso))} UTC`;
}
</script>

<div class="recap-page" bind:this={recapPageEl}>
  {#if onBack}
    <div class="back-row">
      <Button variant="ghost" size="sm" onclick={onBack}>
        <ArrowLeft />
        Back
      </Button>
    </div>
  {/if}

  {#if loading && !recap}
    <div class="grid">
      <RecapSidebar recap={null} period={effectivePeriod} skeleton />
      <RecapHeroBig recap={null} period={effectivePeriod} />
      <div class="body-col">
        <DotMatrixLoader label="Loading recap" />
      </div>
    </div>
  {:else if !recap}
    <div class="grid">
      <RecapSidebar recap={null} period={effectivePeriod} skeleton />
      <RecapHeroBig recap={null} period={effectivePeriod} />
      <div class="body-col">
        <div class="body-callout">
          <CircleAlert size={20} weight="fill" aria-hidden="true" />
          <p>Recap not found.</p>
        </div>
      </div>
    </div>
  {:else}
    <div class="grid">
      <RecapSidebar
        recap={liveRecap}
        period={effectivePeriod}
        skeleton={isGenerating && !hasAnyContent}
      />
      <RecapHeroBig recap={liveRecap} period={effectivePeriod} />
      {#if isGenerating && hasAnyContent && liveRecap}
        <div class="body-col">
          <RecapBody recap={liveRecap} />
          <div class="generating-footer">
            {#if hasThoughtText}
              <Collapsible bind:open={thoughtsOpen}>
                <CollapsibleTrigger class="phase-trigger" aria-label="{phaseLabel}. Toggle streamed thoughts">
                  <span class="phase-label">{phaseLabel}</span>
                  <div class="phase-trigger-meta">
                    <span>Thoughts</span>
                    <span class="phase-trigger-chevron-wrap" data-state={thoughtsOpen ? 'open' : 'closed'}>
                      <CaretDown class="phase-trigger-chevron" aria-hidden="true" />
                    </span>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent class="thought-content">
                  <div class="thought-stream thought-markdown">
                    {#each thoughtBlocks as block (block.id)}
                      <div class="thought-markdown-block">
                        {@html block.html}
                      </div>
                    {/each}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            {:else}
              <span class="phase-label">{phaseLabel}</span>
            {/if}
          </div>
        </div>
      {:else if !isGenerating}
        <div class="body-col">
        {#if isError}
          <div class="error-card">
            <CircleAlert size={16} weight="fill" aria-hidden="true" />
            <div>
              <p class="error-title">
                {recap.errorMessage === "Cancelled by user"
                  ? "Generation stopped."
                  : "Generation failed."}
              </p>
              <p class="error-hint">
                {#if recap.errorMessage && recap.errorMessage !== "Cancelled by user"}
                  {recap.errorMessage}
                {:else if recap.errorMessage === "Cancelled by user"}
                  Click "Resume" to keep going, or "Regenerate" to start fresh.
                {:else}
                  Click "Retry" to try again.
                {/if}
              </p>
            </div>
          </div>
        {:else if isSuperseded}
          <div class="body-callout">
            <p>This recap has been replaced by a newer one for the same period.</p>
          </div>
        {:else if isEmptyComplete}
          <div class="empty-card">
            <p class="empty-title">No PRs merged on this {effectivePeriod === "daily" ? "day" : "week"}.</p>
          </div>
        {:else if isComplete && liveRecap}
          <RecapBody recap={liveRecap} />
        {:else}
          <div class="body-callout">
            <Loader2 size={16} weight="regular" class="animate-spin" aria-hidden="true" />
            <p>Preparing recap…</p>
          </div>
        {/if}

        {#if recap?.completedAt && isComplete}
          <footer class="footer">
            {#if recap.modelUsed}
              Generated by {recap.modelUsed} ·
            {/if}
            {mergedEntries.length} entr{mergedEntries.length === 1 ? "y" : "ies"} ·
            completed {formatCompletedAt(recap.completedAt)}
          </footer>
        {/if}
      </div>
      {/if}
    </div>
    {#if isGenerating && !hasAnyContent}
      <div class="generating-empty">
        <DotMatrixLoader label={phaseLabel} />
        <p class="phase-caption">{phaseLabel}</p>
        {#if hasThoughtText}
          <Collapsible bind:open={thoughtsOpen}>
            <CollapsibleTrigger class="thoughts-trigger" aria-label="Toggle streamed thoughts">
              <span>Thoughts</span>
              <span class="phase-trigger-chevron-wrap" data-state={thoughtsOpen ? 'open' : 'closed'}>
                <CaretDown class="phase-trigger-chevron" aria-hidden="true" />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent class="thought-content">
              <div class="thought-stream thought-markdown">
                {#each thoughtBlocks as block (block.id)}
                  <div class="thought-markdown-block">
                    {@html block.html}
                  </div>
                {/each}
              </div>
            </CollapsibleContent>
          </Collapsible>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
.recap-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem 2rem 4rem;
}

.back-row {
  align-self: flex-start;
}

.grid {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 6rem;
  row-gap: 0;
  align-items: start;
}

:global(.recap-page .grid > .side) {
  grid-column: 1;
  grid-row: 1 / span 2;
}

:global(.recap-page .grid > .hero-big) {
  grid-column: 2;
  grid-row: 1;
}

.body-col {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  min-width: 0;
  max-width: 720px;
  width: 100%;
}

/* Sticky sidebar above 960px. Below, fall back to a single column with the
   sidebar above the body (not sticky). */
:global(.recap-page .side) {
  position: sticky;
  top: 1rem;
  align-self: start;
}

@media (max-width: 960px) {
  .grid {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
  :global(.recap-page .side) {
    position: static;
    width: 100%;
  }
}

.body-callout {
  display: flex;
  gap: 0.625rem;
  align-items: flex-start;
  padding: 1rem 1.25rem;
  background: var(--color-bg-secondary);
  border-radius: 0.5rem;
  color: var(--color-text-secondary);
}

.body-callout p {
  margin: 0;
}

.empty-card {
  display: grid;
  place-items: center;
  padding: 3rem 1.25rem;
  border: 1px dashed color-mix(in srgb, var(--color-text-muted) 30%, transparent);
  border-radius: 0.5rem;
  color: var(--color-text-secondary);
  text-align: center;
}

.empty-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 500;
  color: var(--color-text-primary);
}

.error-card {
  display: flex;
  gap: 0.625rem;
  align-items: flex-start;
  padding: 0.875rem 1rem;
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
  border-radius: 0.5rem;
  color: var(--color-text-primary);
}

.error-card :global(svg) {
  color: var(--color-danger);
  flex-shrink: 0;
  margin-top: 0.15rem;
}

.error-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 500;
}

.error-hint {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.generating-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 6rem 1rem 2rem;
  /* Match the body column's reading width so the streamed thoughts read
     as a column under the loader instead of spanning edge-to-edge. The
     dotmatrix loader and phase caption stay centered via align-items;
     the Collapsible + its content fill this width so the markdown
     paragraph wraps at a comfortable measure. */
  max-width: 45rem;
  width: 100%;
  margin: 0 auto;
}

.generating-empty :global([data-collapsible-root]),
.generating-empty :global(.thought-content) {
  width: 100%;
}

.generating-empty .phase-caption {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-text-muted);
  letter-spacing: 0.005em;
}

.generating-empty :global(.thoughts-trigger) {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.5rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  border-radius: 999px;
}

.generating-empty :global(.thoughts-trigger:hover) {
  color: var(--color-text-secondary);
}

.generating-footer {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  max-width: 42rem;
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 22%, transparent);
}

.generating-footer :global(.phase-trigger) {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.125rem 0;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.phase-label {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}

.phase-trigger-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.phase-trigger-chevron-wrap {
  display: inline-grid;
  place-items: center;
  transition: transform var(--duration-snap) var(--ease-out-expo);
}

.phase-trigger-chevron-wrap[data-state="open"] {
  transform: rotate(180deg);
}

.phase-trigger-chevron-wrap :global(.phase-trigger-chevron) {
  width: 0.75rem;
  height: 0.75rem;
}

.generating-footer :global(.thought-content),
.generating-empty :global(.thought-content) {
  overflow: hidden;
}

.thought-stream {
  margin: 0.375rem 0 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  line-height: 1.6;
}

.thought-markdown-block + .thought-markdown-block {
  margin-top: 0.625rem;
}

.thought-markdown :global(p),
.thought-markdown :global(ul),
.thought-markdown :global(ol),
.thought-markdown :global(pre),
.thought-markdown :global(blockquote) {
  margin: 0 0 0.625rem;
}

.thought-markdown :global(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.08em 0.3em;
  border-radius: 0.25rem;
  background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
  color: var(--color-text-secondary);
}

.footer {
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border-subtle, color-mix(in srgb, var(--color-text-muted) 18%, transparent));
  font-size: 0.7rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  letter-spacing: 0.01em;
}
</style>
