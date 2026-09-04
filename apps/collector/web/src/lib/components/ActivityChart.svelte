<script lang="ts">
import { AreaY, Line, Plot } from "svelteplot";
import type { ServiceTimeseriesPoint, TimeseriesPoint } from "../../../../src/shared/types";

type Mode = "throughput" | "latency" | "service";

interface Props {
  mode: Mode;
  series: TimeseriesPoint[];
  serviceSeries: ServiceTimeseriesPoint[];
}
const { mode, series, serviceSeries }: Props = $props();

// ── Reshape to the long form SveltePlot's stacking expects ──
const throughput = $derived(
  series.flatMap((d) => [
    { t: new Date(d.bucketMs), kind: "ok", value: Math.max(0, d.count - d.errorCount) },
    { t: new Date(d.bucketMs), kind: "errors", value: d.errorCount },
  ]),
);
const latency = $derived(series.map((d) => ({ t: new Date(d.bucketMs), p50: d.p50, p95: d.p95 })));
const svc = $derived(
  serviceSeries.map((d) => ({ t: new Date(d.bucketMs), service: d.serviceName, count: d.count })),
);

const SERVICE_COLORS: Record<string, string> = {
  "revv-server": "var(--accent)",
  "revv-web": "var(--violet)",
  "revv-opencode": "var(--warning)",
};
const serviceNames = $derived([...new Set(serviceSeries.map((d) => d.serviceName))].sort());
const serviceRange = $derived(serviceNames.map((s) => SERVICE_COLORS[s] ?? "var(--ink-muted)"));

const empty = $derived(series.length === 0);
const plotProps = {
  height: 196,
  marginLeft: 34,
  marginRight: 10,
  marginTop: 8,
  marginBottom: 22,
} as const;
</script>

<div class="activity-chart">
  {#if empty}
    <div class="grid h-[196px] place-items-center text-xs text-ink-muted">No activity in this window.</div>
  {:else if mode === "throughput"}
    <Plot
      {...plotProps}
      x={{ label: false }}
      y={{ grid: true, label: false }}
      color={{ domain: ["ok", "errors"], range: ["var(--accent)", "var(--danger)"] }}
    >
      <AreaY data={throughput} x="t" y="value" fill="kind" curve="step" fillOpacity={0.8} />
    </Plot>
    <div class="legend">
      <span><i style:background-color="var(--accent)"></i>throughput</span>
      <span><i style:background-color="var(--danger)"></i>errors</span>
    </div>
  {:else if mode === "latency"}
    <Plot {...plotProps} x={{ label: false }} y={{ grid: true, label: false, tickFormat: (d) => `${String(d)}ms` }}>
      <AreaY data={latency} x="t" y1="p50" y2="p95" fill="var(--accent)" fillOpacity={0.12} curve="natural" />
      <Line data={latency} x="t" y="p95" stroke="var(--accent)" strokeWidth={1.5} curve="natural" />
      <Line data={latency} x="t" y="p50" stroke="var(--ink-2)" strokeWidth={1} strokeOpacity={0.55} curve="natural" />
    </Plot>
    <div class="legend">
      <span><i style:background-color="var(--accent)"></i>p95</span>
      <span><i style:background-color="var(--ink-2)" style:opacity="0.55"></i>p50</span>
      <span class="text-ink-muted">band = p50→p95</span>
    </div>
  {:else}
    <Plot
      {...plotProps}
      x={{ label: false }}
      y={{ grid: true, label: false }}
      color={{ domain: serviceNames, range: serviceRange }}
    >
      <AreaY data={svc} x="t" y="count" fill="service" curve="step" fillOpacity={0.82} />
    </Plot>
    <div class="legend">
      {#each serviceNames as s, i (s)}
        <span><i style:background-color={serviceRange[i]}></i>{s}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Theme SveltePlot's SVG output to the Reading Room tokens. SveltePlot defaults
     text/strokes to `currentColor`, so setting `color` here flows to anything we
     don't target explicitly below. */
  .activity-chart {
    color: var(--ink-muted);
  }
  .activity-chart :global(svg) {
    font-family: var(--font-mono);
    overflow: visible;
  }
  .activity-chart :global(text) {
    fill: var(--ink-muted);
    font-size: 9px;
  }
  .activity-chart :global(.grid-y line),
  .activity-chart :global(.grid-x line) {
    stroke: var(--grid);
  }
  .activity-chart :global(.tick line) {
    stroke: var(--border);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0 1rem;
    margin-top: 0.375rem;
    font-size: 0.6875rem;
    color: var(--ink-2);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .legend i {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 2px;
  }
</style>
