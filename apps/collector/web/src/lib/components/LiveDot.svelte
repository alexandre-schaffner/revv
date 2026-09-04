<script lang="ts">
interface Props {
  live: boolean;
}
const { live }: Props = $props();
</script>

<span
  class="inline-flex items-center gap-1.5 text-xs font-medium"
  title={live ? "Streaming live from the collector" : "Stream disconnected — retrying"}
>
  <span class="relative grid place-items-center">
    <span
      class="size-2 rounded-full transition-colors duration-quick"
      class:live-pulse={live}
      style:background-color={live ? "var(--accent)" : "var(--ink-muted)"}
    ></span>
  </span>
  <span style:color={live ? "var(--accent)" : "var(--ink-muted)"}>
    {live ? "Live" : "Offline"}
  </span>
</span>
