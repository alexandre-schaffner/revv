<script lang="ts">
import { PulseIcon } from "phosphor-svelte";
import { dash, WINDOW_OPTIONS } from "../dashboard.svelte";
import { count } from "../format";
import LiveDot from "./LiveDot.svelte";
import Segmented from "./Segmented.svelte";
import ThemeToggle from "./ThemeToggle.svelte";

const windowOpts = WINDOW_OPTIONS.map((w) => ({ value: String(w.minutes), label: w.label }));
const serviceOpts = $derived([
  { serviceName: "all", count: dash.kpis?.spanCount ?? 0 },
  ...dash.services,
]);
</script>

<header
  class="sticky top-0 z-[var(--z-sticky)] flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-canvas/85 px-5 py-2.5 backdrop-blur-md"
>
  <div class="flex items-center gap-2.5">
    <span class="grid size-7 place-items-center rounded-md" style:background-color="var(--accent-tint)">
      <PulseIcon size={16} weight="bold" style="color: var(--accent)" />
    </span>
    <div class="leading-tight">
      <div class="text-[0.8125rem] font-semibold text-ink">Revv Telemetry</div>
      <div class="text-[0.6875rem] text-ink-muted">local collector</div>
    </div>
  </div>

  <div class="ml-1"><LiveDot live={dash.live} /></div>

  <div class="ms-auto flex flex-wrap items-center gap-3">
    <span class="nums text-xs text-ink-2">
      {count(dash.kpis?.spanCount)}<span class="text-ink-muted"> spans</span>
      <span class="text-ink-muted">·</span>
      {count(dash.kpis?.traceCount)}<span class="text-ink-muted"> traces</span>
    </span>

    <label class="flex items-center gap-1.5 text-xs text-ink-muted">
      <span class="sr-only">Service</span>
      <select
        value={dash.service}
        onchange={(e) => dash.setService(e.currentTarget.value)}
        class="h-7 rounded-md border border-border bg-surface px-2 text-xs text-ink transition-colors duration-quick hover:bg-surface-2 focus:outline-none"
      >
        {#each serviceOpts as s (s.serviceName)}
          <option value={s.serviceName}>
            {s.serviceName === "all" ? "All services" : s.serviceName}
          </option>
        {/each}
      </select>
    </label>

    <Segmented
      options={windowOpts}
      value={String(dash.windowMinutes)}
      onchange={(v) => dash.setWindow(Number(v))}
      ariaLabel="Time window"
    />

    <ThemeToggle />
  </div>
</header>
