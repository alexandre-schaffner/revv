<script lang="ts">
import type { ProjectRecap, RecapPeriod } from "@revv/shared";
import { buildThemePalette, orderThemes, paletteLookup, themeSlug } from "./themes";

interface Props {
  recap: ProjectRecap | null;
  period: RecapPeriod;
}

let { recap, period }: Props = $props();

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
  if (r.period === "daily") return DAY_MONTH_YEAR.format(start);
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

function formatLines(n: number): string {
  return n.toLocaleString("en-US");
}

const eyebrow = $derived(period === "daily" ? "Daily recap" : "Weekly recap");
const title = $derived(recap ? dateTitle(recap) : fallbackDateTitle(period));
const syncedRelative = $derived(recap ? relativeFromNow(recap.generatedAt) : null);

const stats = $derived(recap?.summaryStats ?? null);
const totalAdded = $derived(recap?.totalLinesAdded ?? 0);
const totalRemoved = $derived(recap?.totalLinesRemoved ?? 0);

const themes = $derived(recap ? orderThemes(recap.entries) : []);
const palette = $derived(buildThemePalette(themes.map((t) => t.theme)));

function scrollToTheme(theme: string): void {
  const el = document.getElementById(themeSlug(theme));
  if (!el) return;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}
</script>

<header class="hero-big">
  <div class="hero-text">
    <span class="eyebrow">{eyebrow}</span>
    <h1 class="date">{title}</h1>
    {#if syncedRelative}
      <span class="time-cap">UTC · synced {syncedRelative}</span>
    {:else}
      <span class="time-cap">UTC</span>
    {/if}
  </div>

  {#if stats}
    <dl class="stats">
      <div class="stat">
        <dt>PRs merged</dt>
        <dd>{stats.mergedCount}</dd>
      </div>
      <div class="stat">
        <dt>Authors</dt>
        <dd>{stats.authorCount}</dd>
      </div>
      <div class="stat">
        <dt>Without walkthrough</dt>
        <dd data-warn={stats.walkthroughsMissingCount > 0 ? "true" : "false"}>
          {stats.walkthroughsMissingCount}
        </dd>
      </div>
      <div class="stat">
        <dt>Lines changed</dt>
        <dd class="lines">
          <span class="plus">+{formatLines(totalAdded)}</span>
          <span class="slash">/</span>
          <span class="minus">−{formatLines(totalRemoved)}</span>
        </dd>
      </div>
    </dl>
  {/if}

  {#if themes.length > 0}
    <section class="themes">
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
  font-size: clamp(2.25rem, 3.4vw, 3rem);
  font-weight: 500;
  letter-spacing: -0.025em;
  line-height: 1.05;
  color: var(--color-text-primary);
  text-wrap: balance;
}

.time-cap {
  font-family: var(--font-mono);
  font-size: 0.6rem;
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
  font-size: 0.6rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--color-text-muted);
}

.stat dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.78rem;
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
  gap: 0.4rem;
  padding: 0.25rem 0.55rem;
  background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-size: 0.78rem;
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

.theme-label {
  text-transform: capitalize;
}

.theme-count {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-text-muted);
}
</style>
