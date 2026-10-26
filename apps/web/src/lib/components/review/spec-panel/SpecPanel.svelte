<script lang="ts">
/** The bordered card a spec panel's summary bar and rows sit in. */
import type { Snippet } from "svelte";

interface Props {
  label: string;
  onkeydown?: (e: KeyboardEvent) => void;
  children?: Snippet;
}

let { label, onkeydown, children }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="spec-panel" aria-label={label} role="group" {onkeydown}>
    {@render children?.()}
</section>

<style>
    .spec-panel {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        overflow: hidden;
        font-family: var(--font-mono);
        container-type: inline-size;
        container-name: spec-panel;
        min-width: 0;
        /* Inline-size containment gives the panel no intrinsic width, so it
           would not stretch to fill a grid track or flex parent on its own. */
        width: 100%;
    }
</style>
