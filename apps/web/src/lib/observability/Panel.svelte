<script lang="ts">
// Floating dev-only observability panel. Toggled with Ctrl+Shift+O. Refreshes
// at 500ms while open; sleeps otherwise. Renders the top-N spans by p95 and
// the current metrics snapshot. Plain CSS — no Tailwind here to keep the
// panel self-contained and immune to global theme changes.

import { onDestroy, onMount } from "svelte";
import { snapshot } from "./metrics";
import { isVerbose, setVerbose, summarizeSpans, type SpanSummary } from "./tracer";

let { onclose }: { onclose: () => void } = $props();

let rows = $state<Array<{ name: string } & SpanSummary>>([]);
let counters = $state<Array<{ key: string; count: number }>>([]);
let histograms = $state<Array<{ key: string; p50: number; p95: number; max: number; count: number }>>([]);
let verbose = $state(isVerbose());

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function refresh(): void {
  const grouped = summarizeSpans();
  rows = Object.entries(grouped)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 25);

  const snap = snapshot();
  counters = Object.entries(snap.counters)
    .map(([key, v]) => ({ key, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  histograms = Object.entries(snap.histograms)
    .map(([key, v]) => ({ key, p50: v.p50, p95: v.p95, max: v.max, count: v.count }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 20);
}

onMount(() => {
  refresh();
  refreshTimer = setInterval(refresh, 500);
});

onDestroy(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

function toggleVerbose(): void {
  setVerbose(!verbose);
  verbose = !verbose;
}

function fmt(n: number): string {
  if (n < 1) return `${n.toFixed(2)}ms`;
  if (n < 100) return `${n.toFixed(1)}ms`;
  return `${Math.round(n)}ms`;
}
</script>

<div class="obs-panel" role="dialog" aria-label="Observability inspector">
  <header>
    <strong>obs</strong>
    <span class="hint">Ctrl+Shift+O to close · 500ms refresh</span>
    <span class="grow"></span>
    <label class="verbose">
      <input type="checkbox" checked={verbose} onchange={toggleVerbose} />
      verbose
    </label>
    <button type="button" onclick={onclose}>×</button>
  </header>

  <section>
    <h4>spans (top 25 by p95)</h4>
    {#if rows.length === 0}
      <p class="empty">no spans yet</p>
    {:else}
      <table>
        <thead>
          <tr><th>name</th><th>n</th><th>p50</th><th>p95</th><th>max</th><th>err</th></tr>
        </thead>
        <tbody>
          {#each rows as row (row.name)}
            <tr>
              <td>{row.name}</td>
              <td>{row.count}</td>
              <td>{fmt(row.p50)}</td>
              <td>{fmt(row.p95)}</td>
              <td>{fmt(row.max)}</td>
              <td>{row.errorCount || ""}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if histograms.length > 0}
    <section>
      <h4>histograms</h4>
      <table>
        <thead><tr><th>key</th><th>n</th><th>p50</th><th>p95</th><th>max</th></tr></thead>
        <tbody>
          {#each histograms as row (row.key)}
            <tr>
              <td>{row.key}</td>
              <td>{row.count}</td>
              <td>{fmt(row.p50)}</td>
              <td>{fmt(row.p95)}</td>
              <td>{fmt(row.max)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#if counters.length > 0}
    <section>
      <h4>counters</h4>
      <table>
        <thead><tr><th>key</th><th>count</th></tr></thead>
        <tbody>
          {#each counters as row (row.key)}
            <tr><td>{row.key}</td><td>{row.count}</td></tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>

<style>
  .obs-panel {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 99999;
    width: min(560px, 90vw);
    max-height: 70vh;
    overflow: auto;
    background: rgba(15, 17, 22, 0.95);
    color: #eaeef5;
    border: 1px solid #2a2f38;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    padding: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #2a2f38;
    position: sticky;
    top: 0;
    background: inherit;
  }
  header strong {
    font-size: 12px;
    letter-spacing: 0.04em;
  }
  header .hint {
    color: #8a93a3;
    font-size: 10px;
  }
  header .grow { flex: 1; }
  header .verbose {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: #c0c7d4;
    cursor: pointer;
  }
  header button {
    appearance: none;
    background: transparent;
    color: #eaeef5;
    border: 1px solid #2a2f38;
    border-radius: 4px;
    width: 22px;
    height: 22px;
    cursor: pointer;
    line-height: 1;
  }
  section {
    padding: 10px 12px;
    border-bottom: 1px solid #1f242c;
  }
  section:last-child { border-bottom: none; }
  h4 {
    margin: 0 0 6px 0;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8a93a3;
  }
  .empty {
    color: #6a7280;
    margin: 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    text-align: left;
    padding: 2px 6px;
    border-bottom: 1px solid #1f242c;
    vertical-align: top;
  }
  th {
    color: #8a93a3;
    font-weight: 500;
  }
  td:nth-child(1) {
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td:not(:first-child), th:not(:first-child) {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
