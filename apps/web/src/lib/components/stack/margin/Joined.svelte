<script lang="ts" generics="T">
/*
 * "A, B and C", inline in a margin note's prose: each item rendered by the
 * caller, joined the way a sentence lists things. Adds no element of its own.
 */
import type { Snippet } from "svelte";

interface Props {
  items: readonly T[];
  key: (item: T) => string | number;
  item: Snippet<[T]>;
}

let { items, key, item }: Props = $props();
</script>

{#each items as it, i (key(it))}{#if i > 0}{i === items.length - 1 ? ' and ' : ', '}{/if}{@render item(it)}{/each}
