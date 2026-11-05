<script lang="ts">
import type { ProjectRecap, RecapPeriod } from "@revv/shared";
import type { Snippet } from "svelte";
import { buildRecapHeader, formatLines, formatTheme, paletteLookup, scrollToTheme } from "./themes";

interface Props {
  recap: ProjectRecap | null;
  period: RecapPeriod;
  /** Archive control rendered beside the date — the routes own the calendar's
   *  data, so they hand it in rather than having it drilled through here. */
  archive?: Snippet | undefined;
}

let { recap, period, archive = undefined }: Props = $props();

const header = $derived(buildRecapHeader(recap, period));
</script>

<header class="hero-big">
  <div class="hero-text">
    <div class="date-row">
      <h1 class="date">{header.title}</h1>
      {#if archive}{@render archive()}{/if}
    </div>
    <!-- What kind of recap this is rides under the date, not above it as an
         eyebrow: the title leads, the facts about it follow. -->
    <span class="time-cap">
      <span class="ai-mark" aria-hidden="true"></span>
      {header.eyebrow} · UTC{#if header.syncedRelative}{' · '}synced {header.syncedRelative}{/if}
    </span>
  </div>

  {#if header.stats}
    <dl class="stats">
      <div class="stat">
        <dt>PRs merged</dt>
        <dd>{header.stats.mergedCount}</dd>
      </div>
      <div class="stat">
        <dt>Authors</dt>
        <dd>{header.stats.authorCount}</dd>
      </div>
      <div class="stat">
        <dt>Without walkthrough</dt>
        <dd data-warn={header.stats.walkthroughsMissingCount > 0 ? "true" : "false"}>
          {header.stats.walkthroughsMissingCount}
        </dd>
      </div>
      <div class="stat">
        <dt>Lines changed</dt>
        <dd class="lines">
          <span class="plus">+{formatLines(header.totalAdded)}</span>
          <span class="slash">/</span>
          <span class="minus">−{formatLines(header.totalRemoved)}</span>
        </dd>
      </div>
    </dl>
  {/if}

  {#if header.themes.length > 0}
    <section class="themes">
      <span class="eyebrow themes-eyebrow">Themes</span>
      <ul class="themes-list">
        {#each header.themes as t (t.theme)}
          <li>
            <button
              type="button"
              class="theme-row"
              onclick={() => scrollToTheme(t.theme)}
              aria-label="Jump to {t.theme} chapter"
            >
              <span class="dot" style="--swatch: {paletteLookup(header.palette, t.theme)}" aria-hidden="true"></span>
              <span class="theme-label">{formatTheme(t.theme)}</span>
              <span class="theme-count">{t.count}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</header>

<style>
.hero-big {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding-bottom: 1.5rem;
}

.hero-text {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* The archive control rides the date's baseline but sits at the far edge of
   the reading column: it is page-level navigation, not a modifier on the
   date, and hard against the title it read as part of the heading. */
.date-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 1.5rem;
  min-width: 0;
}

.date-row :global(.archive-trigger) {
  margin-left: auto;
  flex-shrink: 0;
}

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--text-ui);
  font-weight: 500;
  color: var(--color-text-subtle);
}

.ai-mark {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-ai-accent);
  flex-shrink: 0;
}

.date {
  margin: 0;
  font-family: var(--font-serif);
  font-size: var(--text-5xl);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.05;
  color: var(--color-text-primary);
  text-wrap: balance;
}

/* Queries RecapDetail's `recap` container, not the viewport. Has to live in
   this component's own <style>: a @container band written in the parent
   cannot reach a child component's scoped rules. */
@container recap (max-width: 720px) {
  .date {
    font-size: var(--text-4xl);
  }
}

.time-cap {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--text-ui);
  color: var(--color-text-subtle);
}

/* Inline stats: one row of label + figure pairs. */
.stats {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem 1.5rem;
}

.stat {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
}

.stat dt {
  font-size: var(--text-ui);
  color: var(--color-text-subtle);
}

/* Figures in Geist Sans with tabular digits: mono is for code, not counts. */
.stat dd {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
}

.stat dd[data-warn="true"] {
  color: var(--color-warning);
}

.lines .plus {
  color: var(--color-success);
}

.lines .slash {
  color: color-mix(in srgb, var(--color-text-muted) 60%, transparent);
  margin: 0 0.2rem;
}

.lines .minus {
  color: var(--color-danger);
}

.themes {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.themes-eyebrow {
  font-size: var(--text-xs);
  letter-spacing: var(--text-xs--letter-spacing);
}

.themes-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.6rem;
}

.theme-row {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.75rem;
  background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background var(--duration-snap) var(--ease-out-expo);
}

.theme-row:hover {
  background: color-mix(in srgb, var(--color-bg-tertiary) 90%, transparent);
}

.theme-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--swatch, var(--color-text-muted));
  flex-shrink: 0;
}


.theme-count {
  font-variant-numeric: tabular-nums;
  font-size: var(--text-ui);
  color: var(--color-text-muted);
}
</style>
