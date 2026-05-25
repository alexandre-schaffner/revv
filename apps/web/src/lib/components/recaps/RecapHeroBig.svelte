<script lang="ts">
import type { ProjectRecap, RecapPeriod } from "@revv/shared";
import { buildRecapHeader, formatLines, formatTheme, paletteLookup, scrollToTheme } from "./themes";

interface Props {
  recap: ProjectRecap | null;
  period: RecapPeriod;
}

let { recap, period }: Props = $props();

const header = $derived(buildRecapHeader(recap, period));
</script>

<header class="hero-big">
  <div class="hero-text">
    <span class="eyebrow">
      <span class="ai-mark" aria-hidden="true"></span>
      <span>{header.eyebrow}</span>
    </span>
    <h1 class="date">{header.title}</h1>
    {#if header.syncedRelative}
      <span class="time-cap">UTC · synced {header.syncedRelative}</span>
    {:else}
      <span class="time-cap">UTC</span>
    {/if}
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

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--color-text-muted);
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
  font-family: "Newsreader", Georgia, serif;
  font-size: 2.75rem;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.05;
  color: var(--color-text-primary);
  text-wrap: balance;
}

@media (max-width: 960px) {
  .date {
    font-size: 2.25rem;
  }
}

.time-cap {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

/* Inline stats — one row with key + value pairs, compact mono. */
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
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--color-text-muted);
}

.stat dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-primary);
  letter-spacing: -0.005em;
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
  font-size: 0.625rem;
  letter-spacing: 0.16em;
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
  font-size: 0.8125rem;
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
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
</style>
