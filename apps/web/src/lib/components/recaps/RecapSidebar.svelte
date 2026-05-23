<script lang="ts">
import type { ProjectRecap, RecapPeriod } from "@revv/shared";
import { buildThemePalette, orderThemes, paletteLookup, themeSlug } from "./themes";

interface Props {
  recap: ProjectRecap | null;
  period: RecapPeriod;
  skeleton?: boolean;
}

let { recap, period, skeleton = false }: Props = $props();

const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

function dateTitle(r: ProjectRecap): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") {
    return DAY_MONTH_YEAR.format(start);
  }
  const lastDay = new Date(new Date(r.periodEnd).getTime() - 1);
  return `Week of ${DAY_MONTH.format(start)} – ${DAY_MONTH.format(lastDay)}`;
}

function fallbackDateTitle(p: RecapPeriod): string {
  const now = new Date();
  if (p === "daily") return DAY_MONTH_YEAR.format(now);
  const dow = now.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  const start = new Date(now.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
  return `Week of ${DAY_MONTH.format(start)} – ${DAY_MONTH.format(now)}`;
}

function relativeFromNow(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const eyebrow = $derived(period === "daily" ? "Daily recap" : "Weekly recap");
const title = $derived(recap ? dateTitle(recap) : fallbackDateTitle(period));
const syncedRelative = $derived(recap ? relativeFromNow(recap.generatedAt) : null);

const stats = $derived(recap?.summaryStats ?? null);
const totalAdded = $derived(recap?.totalLinesAdded ?? 0);
const totalRemoved = $derived(recap?.totalLinesRemoved ?? 0);

const themes = $derived(recap ? orderThemes(recap.entries) : []);
const palette = $derived(buildThemePalette(themes.map((t) => t.theme)));

function formatLines(n: number): string {
  return n.toLocaleString("en-US");
}

function scrollToTheme(theme: string): void {
  const el = document.getElementById(themeSlug(theme));
  if (!el) return;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}
</script>

<aside class="side">
  <div class="hero">
    <span class="eyebrow">{eyebrow}</span>
    <h1 class="date">{title}</h1>
    {#if syncedRelative}
      <span class="time-cap">UTC · synced {syncedRelative}</span>
    {:else}
      <span class="time-cap">UTC</span>
    {/if}
  </div>

  <div class="stats">
    {#if skeleton || !stats}
      {#each [0, 1, 2, 3] as i (i)}
        <div class="stat skel"><span class="k">—</span><span class="v">—</span></div>
      {/each}
    {:else}
      <div class="stat">
        <span class="k">PRs merged</span>
        <span class="v">{stats.mergedCount}</span>
      </div>
      <div class="stat">
        <span class="k">Authors</span>
        <span class="v">{stats.authorCount}</span>
      </div>
      <div class="stat">
        <span class="k">Without walkthrough</span>
        <span
          class="v"
          data-warn={stats.walkthroughsMissingCount > 0 ? "true" : "false"}
        >{stats.walkthroughsMissingCount}</span>
      </div>
      <div class="stat">
        <span class="k">Lines changed</span>
        <span class="v lines">
          <span class="plus">+{formatLines(totalAdded)}</span>
          <span class="slash">/</span>
          <span class="minus">−{formatLines(totalRemoved)}</span>
        </span>
      </div>
    {/if}
  </div>

  {#if !skeleton && themes.length > 0}
    <div class="themes">
      <span class="eyebrow themes-eyebrow">Themes</span>
      <ul class="themes-list">
        {#each themes as t (t.theme)}
          <li>
            <button
              type="button"
              class="theme-row"
              onclick={() => scrollToTheme(t.theme)}
              aria-label="Jump to {t.theme} chapter"
            >
              <span class="dot" style="--swatch: {paletteLookup(palette, t.theme)}" aria-hidden="true"></span>
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
