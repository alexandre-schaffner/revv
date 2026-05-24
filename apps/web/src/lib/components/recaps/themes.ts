import type { ProjectRecap, RecapPeriod, RecapPrEntry, RecapSummaryStats } from "@revv/shared";

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

export function formatLines(n: number): string {
  return n.toLocaleString("en-US");
}

export function scrollToTheme(theme: string): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(themeSlug(theme));
  if (!el) return;
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

export interface RecapHeader {
  readonly eyebrow: string;
  readonly title: string;
  readonly syncedRelative: string | null;
  readonly stats: RecapSummaryStats | null;
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly themes: ReadonlyArray<ThemeOrder>;
  readonly palette: Map<string, string>;
}

/** Single source of truth for the header data displayed by the body-column
 *  hero and the sticky sidebar. Both components render the same struct so
 *  their date / stats / themes blocks can never drift out of sync. */
export function buildRecapHeader(recap: ProjectRecap | null, period: RecapPeriod): RecapHeader {
  const themes = recap ? orderThemes(recap.entries) : [];
  return {
    eyebrow: period === "daily" ? "Daily recap" : "Weekly recap",
    title: recap ? dateTitle(recap) : fallbackDateTitle(period),
    syncedRelative: recap ? relativeFromNow(recap.generatedAt) : null,
    stats: recap?.summaryStats ?? null,
    totalAdded: recap?.totalLinesAdded ?? 0,
    totalRemoved: recap?.totalLinesRemoved ?? 0,
    themes,
    palette: buildThemePalette(themes.map((t) => t.theme)),
  };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Build a theme→color palette for the whole recap so every theme is
 * guaranteed visually distinct from every other. Hues are evenly spaced
 * around the wheel (360°/N) starting from a per-recap rotation offset,
 * with lightness alternating between two levels to add a second axis of
 * separation when N is large. Deterministic on the input set: same themes
 * in → same colors out.
 */
export function buildThemePalette(themes: ReadonlyArray<string>): Map<string, string> {
  const unique = Array.from(new Set(themes.map((t) => t.toLowerCase()))).sort();
  const palette = new Map<string, string>();
  if (unique.length === 0) return palette;
  const offset = (fnv1a(unique.join("|")) / 0xffffffff) * 360;
  const step = 360 / unique.length;
  unique.forEach((theme, i) => {
    const hue = (offset + i * step) % 360;
    const l = i % 2 === 0 ? 54 : 46;
    palette.set(theme, `hsl(${hue.toFixed(1)} 64% ${l}%)`);
  });
  return palette;
}

export function paletteLookup(palette: Map<string, string>, theme: string): string {
  return palette.get(theme.toLowerCase()) ?? "hsl(0 0% 60%)";
}

/**
 * Stable DOM id for a chapter section. Used by the theme labels in the hero
 * and sidebar to scroll the body column to the matching chapter.
 */
export function themeSlug(theme: string): string {
  return `chapter-${theme
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

export interface ThemeOrder {
  readonly theme: string;
  readonly count: number;
}

export function orderThemes(entries: ReadonlyArray<RecapPrEntry>): ThemeOrder[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.theme, (counts.get(e.theme) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.theme.localeCompare(b.theme)));
}

export interface ThemeChapter {
  readonly theme: string;
  readonly entries: ReadonlyArray<RecapPrEntry>;
}

export function buildChapters(entries: ReadonlyArray<RecapPrEntry>): ThemeChapter[] {
  const order = orderThemes(entries);
  const grouped = new Map<string, RecapPrEntry[]>();
  for (const e of entries) {
    const list = grouped.get(e.theme);
    if (list) list.push(e);
    else grouped.set(e.theme, [e]);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.position - b.position);
  }
  return order.map(({ theme }) => ({ theme, entries: grouped.get(theme) ?? [] }));
}
