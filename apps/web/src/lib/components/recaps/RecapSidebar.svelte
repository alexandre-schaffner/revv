<script lang="ts">
import type { ProjectRecap, RecapPeriod } from "@revv/shared";
import { buildRecapHeader, formatLines, paletteLookup, scrollToTheme } from "./themes";

interface Props {
  recap: ProjectRecap | null;
  period: RecapPeriod;
  skeleton?: boolean;
}

let { recap, period, skeleton = false }: Props = $props();

const header = $derived(buildRecapHeader(recap, period));
</script>

<aside class="side">
  <div class="hero">
    <span class="eyebrow">{header.eyebrow}</span>
    <h1 class="date">{header.title}</h1>
    {#if header.syncedRelative}
      <span class="time-cap">UTC · synced {header.syncedRelative}</span>
    {:else}
      <span class="time-cap">UTC</span>
    {/if}
  </div>

  <div class="stats">
    {#if skeleton || !header.stats}
      {#each [0, 1, 2, 3] as i (i)}
        <div class="stat skel"><span class="k">—</span><span class="v">—</span></div>
      {/each}
    {:else}
      <div class="stat">
        <span class="k">PRs merged</span>
        <span class="v">{header.stats.mergedCount}</span>
      </div>
      <div class="stat">
        <span class="k">Authors</span>
        <span class="v">{header.stats.authorCount}</span>
      </div>
      <div class="stat">
        <span class="k">Without walkthrough</span>
        <span
          class="v"
          data-warn={header.stats.walkthroughsMissingCount > 0 ? "true" : "false"}
        >{header.stats.walkthroughsMissingCount}</span>
      </div>
      <div class="stat">
        <span class="k">Lines changed</span>
        <span class="v lines">
          <span class="plus">+{formatLines(header.totalAdded)}</span>
          <span class="slash">/</span>
          <span class="minus">−{formatLines(header.totalRemoved)}</span>
        </span>
      </div>
    {/if}
  </div>

  {#if !skeleton && header.themes.length > 0}
    <div class="themes">
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
              <span class="theme-label">{t.theme}</span>
              <span class="theme-count">{t.count}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</aside>

<style>
/* The entire sidebar (hero + stats + themes) fades in once the user
   has scrolled past the body-column dashboard. Opacity driven by
   `--shrink` (0 at scroll top, 1 after the dead zone + ramp configured
   in RecapDetail.svelte). The big version of all three blocks lives in
   the body column at the top of the page via RecapHeroBig. */
.side {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  width: 280px;
  flex-shrink: 0;
  opacity: var(--shrink, 0);
  transition: opacity var(--duration-smooth) var(--ease-out-expo);
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--color-text-muted);
}

.date {
  margin: 0;
  font-family: "Newsreader", Georgia, serif;
  font-size: 1.875rem;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.08;
  color: var(--color-text-primary);
  text-wrap: balance;
}

.time-cap {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.stats {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.78rem;
}

.stat .k {
  color: var(--color-text-muted);
}

.stat .v {
  font-family: var(--font-mono);
  color: var(--color-text-primary);
  text-align: right;
  letter-spacing: 0.01em;
}

.stat .v[data-warn="true"] {
  color: var(--color-warning);
}

.stat.skel .k,
.stat.skel .v {
  color: color-mix(in srgb, var(--color-text-muted) 40%, transparent);
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
  gap: 0.55rem;
}

.themes-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.themes-list li {
  display: flex;
}

.theme-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.25rem 0.4rem;
  margin: 0 -0.4rem;
  background: transparent;
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-size: 0.8rem;
  text-align: left;
  color: inherit;
  cursor: pointer;
  transition: background var(--duration-snap) var(--ease-out-expo);
}

.theme-row:hover {
  background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
}

.theme-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.theme-label {
  color: var(--color-text-secondary);
  text-transform: capitalize;
}

.theme-count {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-text-muted);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: var(--swatch, var(--color-text-muted));
}

</style>
