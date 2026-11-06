// Each settings pane describes itself in its own `<script module>`: title,
// nav icon, optional nav badge, and the rows search can find. `panes/index.ts`
// lists them, which is the only registration a new pane needs.

import type { Component } from "svelte";

export interface SettingsRowMeta {
  readonly label: string;
  readonly keywords: readonly string[];
}

/**
 * A searchable row. `SettingsRow` renders `anchor` as `data-setting-id`, so a
 * search hit can scroll to it; panes pass `pane.rows.<key>`, never a string.
 */
export interface SettingsRowRef extends SettingsRowMeta {
  readonly anchor: string;
}

/** Nav accessory. Never color alone: each kind carries its meaning as text. */
export type PaneBadge =
  | { readonly kind: "attention"; readonly title: string }
  | { readonly kind: "count"; readonly count: number; readonly noun: string }
  | { readonly kind: "label"; readonly text: string };

export interface SettingsPaneMeta<Id extends string = string, RowKey extends string = string> {
  readonly id: Id;
  readonly title: string;
  readonly description: string;
  readonly icon: Component<{ size?: number | string }>;
  readonly rows: Readonly<Record<RowKey, SettingsRowRef>>;
  readonly badge?: () => PaneBadge | null;
  /** Loads what the badge reads; runs each time the modal opens. */
  readonly onModalOpen?: () => void;
}

export function defineSettingsPane<const Id extends string, RowKey extends string>(
  meta: Omit<SettingsPaneMeta<Id, RowKey>, "rows"> & {
    readonly rows: Readonly<Record<RowKey, SettingsRowMeta>>;
  },
): SettingsPaneMeta<Id, RowKey> {
  const rows = Object.fromEntries(
    Object.entries<SettingsRowMeta>(meta.rows).map(([key, row]) => [
      key,
      { ...row, anchor: `${meta.id}.${key}` },
    ]),
  ) as Record<RowKey, SettingsRowRef>;
  return { ...meta, rows };
}

/** Rows for a list known only at runtime, e.g. one per integration provider. */
export function rowsFor<K extends string>(
  keys: readonly K[],
  row: (key: K) => SettingsRowMeta,
): Record<K, SettingsRowMeta> {
  return Object.fromEntries(keys.map((key) => [key, row(key)])) as Record<K, SettingsRowMeta>;
}

type SearchablePane = Pick<SettingsPaneMeta, "id" | "title" | "rows">;

export interface SettingsSearchHit<P extends SearchablePane = SearchablePane> {
  readonly pane: P;
  readonly row: SettingsRowRef;
  /** Where the query matched inside `row.label`, for highlighting; null for keyword hits. */
  readonly match: { start: number; end: number } | null;
}

/**
 * Plain substring search over labels, then keywords, then pane titles. Label
 * hits rank first (earliest match first), so typing "wrap" puts "Wrap long
 * lines" above anything that merely lists wrap as a keyword.
 */
export function searchSettings<P extends SearchablePane>(
  panes: readonly P[],
  query: string,
): SettingsSearchHit<P>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { hit: SettingsSearchHit<P>; score: number }[] = [];
  for (const pane of panes) {
    for (const row of Object.values<SettingsRowRef>(pane.rows)) {
      const at = row.label.toLowerCase().indexOf(q);
      if (at !== -1) {
        scored.push({
          hit: { pane, row, match: { start: at, end: at + q.length } },
          score: 100 - at,
        });
      } else if (row.keywords.some((k) => k.includes(q))) {
        scored.push({ hit: { pane, row, match: null }, score: 10 });
      } else if (pane.title.toLowerCase().includes(q)) {
        scored.push({ hit: { pane, row, match: null }, score: 1 });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.hit);
}
