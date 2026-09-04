<script lang="ts">
import { CaretDown, CaretUp } from "phosphor-svelte";
import type { OperationSummary } from "../../../../src/shared/types";
import { categoryMeta } from "../category";
import { count as fmtCount, ms, percent } from "../format";
import { errorRateTone, toneColor } from "../tone";

interface Props {
  rows: OperationSummary[];
}
const { rows }: Props = $props();

type Key = "name" | "count" | "p50" | "p95" | "max" | "errorRate";
let sortKey = $state<Key>("count");
let desc = $state(true);

const sorted = $derived.by(() => {
  const out = [...rows];
  out.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const cmp =
      typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return desc ? -cmp : cmp;
  });
  return out;
});

function setSort(k: Key): void {
  if (sortKey === k) desc = !desc;
  else {
    sortKey = k;
    desc = k !== "name";
  }
}

const cols: { key: Key; label: string; num: boolean }[] = [
  { key: "name", label: "Operation", num: false },
  { key: "count", label: "Count", num: true },
  { key: "p50", label: "p50", num: true },
  { key: "p95", label: "p95", num: true },
  { key: "max", label: "Max", num: true },
  { key: "errorRate", label: "Errors", num: true },
];
</script>

<div class="overflow-x-auto">
  <table class="w-full border-collapse text-xs">
    <thead>
      <tr class="border-b border-border-subtle text-ink-muted">
        {#each cols as col (col.key)}
          <th
            class="px-3 py-2 font-medium {col.num ? 'text-right' : 'text-left'}"
            class:w-full={col.key === "name"}
          >
            <button
              type="button"
              onclick={() => setSort(col.key)}
              class="inline-flex items-center gap-1 transition-colors duration-quick hover:text-ink {col.num ? 'flex-row-reverse' : ''}"
              class:text-ink={sortKey === col.key}
            >
              {col.label}
              {#if sortKey === col.key}
                {#if desc}<CaretDown size={10} weight="bold" />{:else}<CaretUp size={10} weight="bold" />{/if}
              {/if}
            </button>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each sorted as row (row.name)}
        {@const tone = errorRateTone(row.errorRate)}
        {@const cat = categoryMeta(row.category)}
        <tr class="border-b border-border-subtle/60 transition-colors duration-quick last:border-0 hover:bg-surface-2/50">
          <td class="px-3 py-1.5">
            <div class="font-mono text-ink truncate max-w-[28ch]" title={row.name}>{row.name}</div>
            <div class="flex items-center gap-1.5 text-[0.625rem] text-ink-muted">
              <span class="inline-flex items-center gap-1" title="category: {cat.label}">
                <span class="size-1.5 rounded-full" style:background-color={cat.color}></span>{cat.label}
              </span>
              <span>·</span>
              <span>{row.serviceName}</span>
            </div>
          </td>
          <td class="nums px-3 py-1.5 text-right text-ink-2">{fmtCount(row.count)}</td>
          <td class="nums px-3 py-1.5 text-right text-ink-2">{ms(row.p50)}</td>
          <td class="nums px-3 py-1.5 text-right text-ink">{ms(row.p95)}</td>
          <td class="nums px-3 py-1.5 text-right text-ink-muted">{ms(row.max)}</td>
          <td class="nums px-3 py-1.5 text-right">
            {#if row.errorCount > 0}
              <span style:color={toneColor[tone]}>{percent(row.errorRate)}</span>
            {:else}
              <span class="text-ink-muted">0%</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
