<script lang="ts">
interface Props {
  text: string;
}

let { text }: Props = $props();

interface Segment {
  readonly kind: "text" | "code";
  readonly value: string;
}

const segments = $derived.by<Segment[]>(() => {
  const out: Segment[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "`") {
      buf += ch;
      i++;
      continue;
    }
    const close = text.indexOf("`", i + 1);
    if (close === -1) {
      buf += text.slice(i);
      break;
    }
    if (buf.length > 0) {
      out.push({ kind: "text", value: buf });
      buf = "";
    }
    out.push({ kind: "code", value: text.slice(i + 1, close) });
    i = close + 1;
  }
  if (buf.length > 0) out.push({ kind: "text", value: buf });
  return out;
});
</script>

{#each segments as seg, i (i)}
  {#if seg.kind === "code"}
    <code class="codechip">{seg.value}</code>
  {:else}
    {seg.value}
  {/if}
{/each}

<style>
.codechip {
  display: inline-block;
  padding: 0.05em 0.4em;
  margin: 0 0.05em;
  font-family: var(--font-mono);
  font-size: 0.85em;
  line-height: 1.4;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-muted) 18%, transparent);
  border-radius: 0.3em;
  vertical-align: baseline;
}
</style>
