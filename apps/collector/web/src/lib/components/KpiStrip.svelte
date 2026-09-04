<script lang="ts">
import { dash } from "../dashboard.svelte";
import { decimal, ms, percent, tokens } from "../format";
import { errorRateTone, toneColor, toneIcon } from "../tone";
import Sparkline from "./Sparkline.svelte";

const k = $derived(dash.kpis);

// Error-rate over the window, derived from the same buckets the chart uses.
const errSeries = $derived(dash.series.map((b) => (b.count > 0 ? b.errorCount / b.count : 0)));

const errTone = $derived(errorRateTone(k?.errorRate ?? null));
const ErrIcon = $derived(toneIcon[errTone]);

type Cell = { label: string; value: string; sub?: string };
const cells = $derived<Cell[]>([
  { label: "Walkthrough gen", value: ms(k?.walkthroughGenMedianMs ?? null), sub: "median" },
  { label: "Time to first token", value: ms(k?.ttftMedianMs ?? null), sub: "median, agents" },
  { label: "Tool calls", value: decimal(k?.avgToolCallsPerWalkthrough ?? null), sub: "avg / run" },
  { label: "Tokens", value: tokens(k?.avgTokensPerWalkthrough ?? null), sub: "avg / run" },
  { label: "GitHub", value: ms(k?.githubP95Ms ?? null), sub: "p95 latency" },
]);
</script>

<div class="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface/60 sm:grid-cols-3 lg:grid-cols-6">
  {#each cells as cell, i (cell.label)}
    <div
      class="border-border-subtle p-4 [&:not(:last-child)]:border-b lg:[&:not(:last-child)]:border-b-0 lg:[&:not(:last-child)]:border-r"
      class:border-r={i % 2 === 0}
    >
      <div class="text-xs font-medium text-ink-muted">{cell.label}</div>
      {#if dash.firstLoad}
        <div class="mt-2 h-7 w-16 animate-pulse rounded bg-surface-2"></div>
      {:else}
        <div class="nums mt-1 text-2xl font-medium tracking-tight text-ink">{cell.value}</div>
      {/if}
      {#if cell.sub}<div class="mt-0.5 text-[0.6875rem] text-ink-muted">{cell.sub}</div>{/if}
    </div>
  {/each}

  <!-- Error rate: the health cell — earns a tone marker + a sparkline. -->
  <div class="col-span-2 flex items-start justify-between gap-3 p-4 sm:col-span-1">
    <div class="min-w-0">
      <div class="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        Error rate
        <ErrIcon size={12} weight="fill" style="color: {toneColor[errTone]}" />
      </div>
      {#if dash.firstLoad}
        <div class="mt-2 h-7 w-14 animate-pulse rounded bg-surface-2"></div>
      {:else}
        <div class="nums mt-1 text-2xl font-medium tracking-tight" style:color={toneColor[errTone]}>
          {percent(k?.errorRate ?? null)}
        </div>
      {/if}
      <div class="mt-0.5 text-[0.6875rem] text-ink-muted">across all spans</div>
    </div>
    {#if !dash.firstLoad && errSeries.length > 1}
      <div class="mt-1 shrink-0"><Sparkline values={errSeries} color={toneColor[errTone]} /></div>
    {/if}
  </div>
</div>
