import type { ProjectRecap, RecapPeriod, RecapPrEntry, RecapSummaryStats } from "@revv/shared";
import { prefersReducedMotion } from "$lib/motion";
import { formatRecapTitle, openSpan, recapSpan } from "$lib/recaps/period-window";
import { hash32 } from "$lib/utils/hash";

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

/** The recap lede allows `<strong>` and `<em>` only: everything else is escaped. */
export function sanitizeLedeHtml(raw: string): string {
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/&lt;strong&gt;/gi, "<strong>")
    .replace(/&lt;\/strong&gt;/gi, "</strong>")
    .replace(/&lt;em&gt;/gi, "<em>")
    .replace(/&lt;\/em&gt;/gi, "</em>");
}

export function formatLines(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Acronyms the agent emits lowercase, where sentence-casing produces a word
 * that reads as a typo in a developer tool — "Api", "Ci", "Sdk". Matched on
 * the whole theme only; a theme like `api gateway` is not worth a tokenizer.
 */
const THEME_ACRONYMS = new Set([
  "a11y",
  "api",
  "aws",
  "cd",
  "ci",
  "cli",
  "cms",
  "cors",
  "cron",
  "css",
  "db",
  "dns",
  "dx",
  "e2e",
  "gpu",
  "grpc",
  "html",
  "http",
  "i18n",
  "ios",
  "js",
  "json",
  "orm",
  "rpc",
  "sdk",
  "seo",
  "sql",
  "ssr",
  "svg",
  "ts",
  "ui",
  "ux",
]);

/** Themes arrive lowercase from the agent (`auth`, `payments`, `open source`).
 *  Render-time sentence-case keeps reading-room voice without breaking the
 *  stored value used for slugs, palette lookup, and equality joins. */
export function formatTheme(theme: string): string {
  const head = theme.charAt(0);
  if (head === "") return theme;
  if (THEME_ACRONYMS.has(theme)) return theme.toUpperCase();
  return head.toUpperCase() + theme.slice(1);
}

export function scrollToTheme(theme: string): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(themeSlug(theme));
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
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

/** Shared by the body-column hero and the sticky sidebar, so they never drift. */
export function buildRecapHeader(recap: ProjectRecap | null, period: RecapPeriod): RecapHeader {
  const themes = recap ? orderThemes(recap.entries) : [];
  return {
    eyebrow: period === "daily" ? "Daily recap" : "Weekly recap",
    title: formatRecapTitle(recap ? recapSpan(recap) : openSpan(period)),
    syncedRelative: recap ? relativeFromNow(recap.generatedAt) : null,
    stats: recap?.summaryStats ?? null,
    totalAdded: recap?.totalLinesAdded ?? 0,
    totalRemoved: recap?.totalLinesRemoved ?? 0,
    themes,
    palette: buildThemePalette(themes.map((t) => t.theme)),
  };
}

/**
 * Every theme visually distinct: hues evenly spaced around the wheel from a
 * per-recap rotation, lightness alternating between two levels. Same themes
 * in, same colors out.
 */
export function buildThemePalette(themes: ReadonlyArray<string>): Map<string, string> {
  const unique = Array.from(new Set(themes.map((t) => t.toLowerCase()))).sort();
  const palette = new Map<string, string>();
  if (unique.length === 0) return palette;
  const offset = (hash32(unique.join("|")) / 0xffffffff) * 360;
  const step = 360 / unique.length;
  unique.forEach((theme, i) => {
    const hue = (offset + i * step) % 360;
    // OKLCH keeps lightness perceptually constant across hues (HSL doesn't);
    // chroma is fixed at 0.12.
    const l = i % 2 === 0 ? 56 : 48;
    palette.set(theme, `oklch(${l}% 0.12 ${hue.toFixed(1)})`);
  });
  return palette;
}

const NEUTRAL_SWATCH = "oklch(60% 0 0)";

export function paletteLookup(palette: Map<string, string>, theme: string): string {
  return palette.get(theme.toLowerCase()) ?? NEUTRAL_SWATCH;
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
