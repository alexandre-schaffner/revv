<script lang="ts">
import { X } from "phosphor-svelte";
import type { SpanRecord } from "../../../../src/shared/types";
import { dash } from "../dashboard.svelte";
import { ms } from "../format";

interface Row {
  span: SpanRecord;
  depth: number;
  leftPct: number;
  widthPct: number;
}

const layout = $derived.by(() => {
  const spans = dash.traceSpans;
  if (spans.length === 0) return { rows: [] as Row[], totalMs: 0 };

  const minStart = Math.min(...spans.map((s) => s.startMs));
  const maxEnd = Math.max(...spans.map((s) => s.startMs + s.durationMs));
  const total = Math.max(1, maxEnd - minStart);

  const byParent = new Map<string | null, SpanRecord[]>();
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    // Treat a parent outside this trace slice as a root.
    const key = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    const arr = byParent.get(key) ?? [];
    arr.push(s);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.startMs - b.startMs);

  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const s of byParent.get(parent) ?? []) {
      rows.push({
        span: s,
        depth,
        leftPct: ((s.startMs - minStart) / total) * 100,
        widthPct: Math.max(0.8, (s.durationMs / total) * 100),
      });
      walk(s.spanId, depth + 1);
    }
  };
  walk(null, 0);
  return { rows, totalMs: total };
});
</script>

<div class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
  <div class="flex items-baseline gap-2 min-w-0">
    <h2 class="text-[0.8125rem] font-semibold text-ink">Trace</h2>
    <code class="font-mono text-xs text-ink-muted truncate">{dash.selectedTraceId?.slice(0, 16)}…</code>
    {#if layout.rows.length > 0}
      <span class="text-xs text-ink-muted">{layout.rows.length} spans · {ms(layout.totalMs)}</span>
    {/if}
  </div>
  <button
    type="button"
    onclick={() => dash.closeTrace()}
    class="grid size-7 shrink-0 place-items-center rounded-md text-ink-2 transition-colors duration-quick hover:bg-surface-2 hover:text-ink"
    aria-label="Close trace"
  >
    <X size={14} weight="bold" />
  </button>
</div>

<div class="p-2">
  {#if dash.traceLoading}
    <div class="space-y-1.5 p-2">
      {#each Array(4) as _, i (i)}<div class="h-5 animate-pulse rounded bg-surface-2"></div>{/each}
    </div>
  {:else if layout.rows.length === 0}
    <p class="px-1 py-6 text-center text-xs text-ink-muted">No spans for this trace in the window.</p>
  {:else}
    <ul class="flex flex-col">
      {#each layout.rows as row (row.span.spanId)}
        {@const isError = row.span.statusCode === 2}
        <li
          class="row-in grid grid-cols-[minmax(8rem,18rem)_1fr] items-center gap-3 rounded px-2 py-1 transition-colors duration-quick hover:bg-surface-2/50"
        >
          <div class="flex items-center gap-1.5 min-w-0" style:padding-left="{row.depth * 12}px">
            <span class="size-1.5 shrink-0 rounded-full" style:background-color={isError ? "var(--danger)" : "var(--accent)"}></span>
            <span class="truncate font-mono text-xs text-ink" title={row.span.name}>{row.span.name}</span>
          </div>
          <div class="relative h-4">
            <div class="absolute inset-y-0 left-0 right-0 rounded-sm" style:background-color="var(--chart-track)"></div>
            <div
              class="absolute inset-y-0 flex items-center rounded-sm"
              style:left="{row.leftPct}%"
              style:width="{row.widthPct}%"
              style:background-color={isError ? "color-mix(in srgb, var(--danger) 70%, transparent)" : "color-mix(in srgb, var(--accent) 65%, transparent)"}
              title="{row.span.name} · {ms(row.span.durationMs)}"
            ></div>
            <span
              class="nums absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[0.625rem] text-ink-2"
              style:left="calc({Math.min(row.leftPct, 80)}% + {row.widthPct > 12 ? '6px' : 'calc(' + row.widthPct + '% + 6px)'})"
            >{ms(row.span.durationMs)}</span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
