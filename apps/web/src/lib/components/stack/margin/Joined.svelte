<script lang="ts" generics="T">
import type { Snippet } from "svelte";

interface Props {
  items: readonly T[];
  key: (item: T) => string | number;
  item: Snippet<[T]>;
}

let { items, key, item }: Props = $props();
</script>

{#each items as it, i (key(it))}{#if i > 0}{i === items.length - 1 ? ' and ' : ', '}{/if}{@render item(it)}{/each}
