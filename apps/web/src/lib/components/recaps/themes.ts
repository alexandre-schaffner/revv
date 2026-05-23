import type { RecapPrEntry } from "@revv/shared";

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
