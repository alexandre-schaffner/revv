<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import type { Snippet } from "svelte";

interface Props {
  label: string;
  icon?: Snippet;
  trailing?: Snippet;
  chevron?: boolean;
}

let { label, icon, trailing, chevron = true }: Props = $props();
</script>

<button
  type="button"
  class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-bg-secondary"
>
  {#if icon}
    {@render icon()}
  {/if}
  <span class="text-xs text-text-secondary">{label}</span>
  {#if trailing}
    {@render trailing()}
  {/if}
  {#if chevron}
    <CaretDown size={10} weight="fill" class="text-text-muted" />
  {/if}
</button>
