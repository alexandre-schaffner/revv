<script lang="ts">
import { ArrowRight } from "phosphor-svelte";
import type { SpanRecord } from "../../../../src/shared/types";
import { dash } from "../dashboard.svelte";
import { ago, ms } from "../format";
import { httpTone, toneColor } from "../tone";

interface Props {
  rows: SpanRecord[];
  variant: "slow" | "errors";
  empty: string;
}
const { rows, variant, empty }: Props = $props();
</script>

{#if rows.length === 0}
  <p class="px-1 py-6 text-center text-xs text-ink-muted">{empty}</p>
{:else}
  <ul class="-mx-1 flex flex-col">
    {#each rows as span (span.traceId + span.spanId)}
      {@const tone = httpTone(span.httpStatus)}
      <li>
        <button
          type="button"
          onclick={() => dash.selectTrace(span.traceId)}
          class="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-quick hover:bg-surface-2/60"
          class:bg-accent-tint={dash.selectedTraceId === span.traceId}
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-mono text-xs text-ink" title={span.name}>{span.name}</span>
              {#if span.httpStatus != null}
                <span
                  class="nums shrink-0 rounded px-1 py-px text-[0.625rem] font-medium"
                  style:color={toneColor[tone]}
                  style:background-color="color-mix(in srgb, {toneColor[tone]} 12%, transparent)"
                >{span.httpStatus}</span>
              {/if}
            </div>
            <div class="flex items-center gap-1.5 text-[0.625rem] text-ink-muted">
              <span>{span.serviceName}</span>
              <span>·</span>
              <span class="nums">{ago(span.startMs, dash.now)}</span>
              {#if variant === "errors" && span.statusMessage}
                <span>·</span>
                <span class="truncate" style:color="var(--danger)" title={span.statusMessage}>{span.statusMessage}</span>
              {/if}
            </div>
          </div>
          <span class="nums shrink-0 text-xs font-medium" class:text-ink={variant === "slow"} class:text-ink-2={variant === "errors"}>{ms(span.durationMs)}</span>
          <ArrowRight size={12} class="shrink-0 text-ink-muted opacity-0 transition-opacity duration-quick group-hover:opacity-100" />
        </button>
      </li>
    {/each}
  </ul>
{/if}
