<script lang="ts">
// The signature pill-track: inactive options recede into a tinted track, the
// active one steps up to the canvas with a soft lift. No borders.
interface Option {
  value: string;
  label: string;
}
interface Props {
  options: Option[];
  value: string;
  onchange: (value: string) => void;
  ariaLabel: string;
}
const { options, value, onchange, ariaLabel }: Props = $props();
</script>

<div
  role="radiogroup"
  aria-label={ariaLabel}
  class="inline-flex items-center gap-0.5 rounded-md p-0.5"
  style:background-color="var(--chart-track)"
>
  {#each options as opt (opt.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      onclick={() => onchange(opt.value)}
      class="rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors duration-quick"
      class:text-ink={value === opt.value}
      class:text-ink-muted={value !== opt.value}
      style:background-color={value === opt.value ? "var(--canvas)" : "transparent"}
      style:box-shadow={value === opt.value ? "0 1px 3px rgba(42,40,37,0.08)" : "none"}
    >
      {opt.label}
    </button>
  {/each}
</div>
