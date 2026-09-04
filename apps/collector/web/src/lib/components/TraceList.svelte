<script lang="ts">
import { WarningOctagon } from "phosphor-svelte";
import type { TraceSummary } from "../../../../src/shared/types";
import { dash } from "../dashboard.svelte";
import { ago, ms } from "../format";

interface Props {
  rows: TraceSummary[];
}
const { rows }: Props = $props();
</script>

{#if rows.length === 0}
  <p class="px-1 py-6 text-center text-xs text-ink-muted">No traces in this window.</p>
{:else}
  <ul class="-mx-1 grid gap-0.5 sm:grid-cols-2">
    {#each rows as t (t.traceId)}
      <li>
        <button
          type="button"
          onclick={() => dash.selectTrace(t.traceId)}
          class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-quick hover:bg-surface-2/60"
          class:bg-accent-tint={dash.selectedTraceId === t.traceId}
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-mono text-xs text-ink" title={t.rootName}>{t.rootName}</span>
              {#if t.errorCount > 0}
                <WarningOctagon size={12} weight="fill" class="shrink-0" style="color: var(--danger)" />
              {/if}
            </div>
            <div class="nums text-[0.625rem] text-ink-muted">
              {t.spanCount} spans · {ago(t.startMs, dash.now)}
            </div>
          </div>
          <span class="nums shrink-0 text-xs font-medium text-ink-2">{ms(t.durationMs)}</span>
        </button>
      </li>
    {/each}
  </ul>
{/if}
