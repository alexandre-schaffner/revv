<script lang="ts">
import { WarningCircle } from "phosphor-svelte";
import { onDestroy, onMount } from "svelte";
import { categoryMeta } from "./lib/category";
import ActivityChart from "./lib/components/ActivityChart.svelte";
import EmptyState from "./lib/components/EmptyState.svelte";
import KpiStrip from "./lib/components/KpiStrip.svelte";
import Panel from "./lib/components/Panel.svelte";
import Segmented from "./lib/components/Segmented.svelte";
import SpanList from "./lib/components/SpanList.svelte";
import SummaryTable from "./lib/components/SummaryTable.svelte";
import TopBar from "./lib/components/TopBar.svelte";
import TraceList from "./lib/components/TraceList.svelte";
import TraceWaterfall from "./lib/components/TraceWaterfall.svelte";
import { dash } from "./lib/dashboard.svelte";

let waterfallEl = $state<HTMLElement | null>(null);
let chartMode = $state<"throughput" | "latency" | "service">("throughput");
const chartModes = [
  { value: "throughput", label: "Throughput" },
  { value: "latency", label: "Latency" },
  { value: "service", label: "By service" },
];

onMount(() => dash.start());
onDestroy(() => dash.stop());

// Bring the waterfall into view when a trace is opened.
$effect(() => {
  if (dash.selectedTraceId && waterfallEl) {
    waterfallEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

const failedToConnect = $derived(dash.phase === "error" && dash.firstLoad);
</script>

<div class="min-h-screen">
  <TopBar />

  <main class="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 py-5">
    {#if dash.phase === "error" && !dash.firstLoad}
      <div
        class="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-ink-2"
        style:background-color="var(--warning-tint)"
      >
        <WarningCircle size={14} weight="fill" style="color: var(--warning)" />
        Lost the collector connection — showing the last good snapshot. Retrying…
      </div>
    {/if}

    {#if failedToConnect}
      <div class="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <span class="grid size-12 place-items-center rounded-lg" style:background-color="var(--danger-tint)">
          <WarningCircle size={24} weight="bold" style="color: var(--danger)" />
        </span>
        <h2 class="mt-5 text-base font-semibold text-ink">Can't reach the collector</h2>
        <p class="mt-1.5 text-sm text-ink-2">
          The query API at this origin isn't responding. Is the collector running on its port?
        </p>
      </div>
    {:else if dash.isEmpty}
      <KpiStrip />
      <EmptyState />
    {:else}
      <KpiStrip />

      <Panel title="Activity">
        {#snippet actions()}
          <Segmented
            options={chartModes}
            value={chartMode}
            onchange={(v) => (chartMode = v as typeof chartMode)}
            ariaLabel="Chart mode"
          />
        {/snippet}
        <ActivityChart mode={chartMode} series={dash.series} serviceSeries={dash.serviceSeries} />
      </Panel>

      {#if dash.selectedTraceId}
        <section
          bind:this={waterfallEl}
          class="row-in scroll-mt-20 overflow-hidden rounded-lg border border-border bg-surface/60"
        >
          <TraceWaterfall />
        </section>
      {/if}

      <div class="grid gap-4 lg:grid-cols-3">
        <div class="lg:col-span-2">
          <Panel title="Operations" hint="{dash.summary.length} ops" flush>
            {#snippet actions()}
              <button
                type="button"
                onclick={() => dash.setShowInternal(!dash.showInternal)}
                class="rounded-md px-2 py-1 text-[0.6875rem] font-medium transition-colors duration-quick hover:bg-surface-2"
                class:text-accent={dash.showInternal}
                class:text-ink-muted={!dash.showInternal}
                title="Bookkeeping spans (emitEvent, setStatus, …) are hidden by default"
              >
                {dash.showInternal ? "Hide internal" : "Show internal"}
              </button>
            {/snippet}
            {#if dash.categoryFacets.length > 0}
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2 text-[0.625rem] text-ink-muted">
                {#each dash.categoryFacets as f (f.category)}
                  {@const m = categoryMeta(f.category)}
                  <span class="inline-flex items-center gap-1.5">
                    <span class="size-1.5 rounded-full" style:background-color={m.color}></span>
                    <span class="text-ink-2">{m.label}</span>
                    <span class="nums">{f.count}</span>
                  </span>
                {/each}
              </div>
            {/if}
            <SummaryTable rows={dash.summary} />
          </Panel>
        </div>
        <div class="flex flex-col gap-4">
          <Panel title="Slowest spans">
            <SpanList rows={dash.slow} variant="slow" empty="No spans yet." />
          </Panel>
          <Panel title="Errors" hint={dash.errors.length > 0 ? String(dash.errors.length) : undefined}>
            <SpanList rows={dash.errors} variant="errors" empty="No errors. Quiet is good." />
          </Panel>
        </div>
      </div>

      <Panel title="Recent traces">
        <TraceList rows={dash.traces} />
      </Panel>
    {/if}
  </main>
</div>
