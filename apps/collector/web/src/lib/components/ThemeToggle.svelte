<script lang="ts">
import { Desktop, Moon, Sun } from "phosphor-svelte";
import { theme } from "../theme.svelte";

const label = $derived(
  theme.current === "light"
    ? "Light theme — switch to dark"
    : theme.current === "dark"
      ? "Dark theme — switch to system"
      : "System theme — switch to light",
);
</script>

<button
  type="button"
  onclick={() => theme.cycle()}
  title={label}
  aria-label={label}
  class="grid size-8 place-items-center rounded-md text-ink-2 transition-colors duration-quick hover:bg-surface-2 hover:text-ink"
>
  {#if theme.current === "light"}
    <Sun size={16} weight="bold" />
  {:else if theme.current === "dark"}
    <Moon size={16} weight="bold" />
  {:else}
    <Desktop size={16} weight="bold" />
  {/if}
</button>
