<script lang="ts">
interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Draw a faint area fill under the line. */
  fill?: boolean;
}

const { values, width = 96, height = 28, color = "var(--accent)", fill = true }: Props = $props();

const pad = 1.5;
const path = $derived.by(() => {
  const n = values.length;
  if (n === 0) return { line: "", area: "" };
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const dx = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  const pts = values.map((v, i) => {
    const x = pad + i * dx;
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area =
    first && last
      ? `${line} L${last[0].toFixed(2)} ${height} L${first[0].toFixed(2)} ${height} Z`
      : "";
  return { line, area };
});
</script>

<svg {width} {height} viewBox="0 0 {width} {height}" class="overflow-visible" aria-hidden="true">
  {#if fill && path.area}
    <path d={path.area} fill={color} opacity="0.1" />
  {/if}
  <path
    d={path.line}
    fill="none"
    stroke={color}
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
