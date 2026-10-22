<script lang="ts">
import type { RecapPrEntry } from "@revv/shared";
import InlineText from "./InlineText.svelte";

interface Props {
  entry: RecapPrEntry;
}

let { entry }: Props = $props();

const prNumberLabel = $derived(entry.prExternalId > 0 ? `#${entry.prExternalId}` : "");
const title = $derived(entry.prTitle || "(PR removed)");
const href = $derived(`/review/${entry.prId}`);
const showDiff = $derived(entry.linesAdded > 0 || entry.linesRemoved > 0);

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
</script>

<div class="pr-row">
  <div class="title-line">
    <span class="verb">{entry.verb}</span>
    <a class="title" href={href} data-sveltekit-preload-data="hover">{title}</a>
    {#if prNumberLabel}
      <span class="pr-num">{prNumberLabel}</span>
    {/if}
    {#if showDiff}
      <span class="diff">
        <span class="plus">+{fmt(entry.linesAdded)}</span>
        <span class="minus">−{fmt(entry.linesRemoved)}</span>
      </span>
    {/if}
  </div>
  <p class="description">
    <InlineText text={entry.description} />
  </p>
</div>

<style>
.pr-row {
  display: flex;
  flex-direction: column;
  padding: 0.625rem 0;
}

.title-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.625rem;
  line-height: 1.35;
}

.verb {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
}

.title {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-text-primary);
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-color: color-mix(in srgb, var(--color-text-muted) 50%, transparent);
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
  transition: color var(--duration-snap) var(--ease-soft);
}

.title:hover {
  color: var(--color-accent);
  text-decoration-color: var(--color-accent);
}

.pr-num {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-text-muted);
  letter-spacing: 0.02em;
}

.diff {
  display: inline-flex;
  gap: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.01em;
}

.diff .plus {
  color: var(--color-success);
}

.diff .minus {
  color: var(--color-danger);
}

.description {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  line-height: 1.55;
}
</style>
