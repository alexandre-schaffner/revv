<script lang="ts">
/** The bordered card a spec panel's summary bar and rows sit in. */
import type { Snippet } from "svelte";
import SpecEmpty from "./SpecEmpty.svelte";

interface Props {
  label: string;
  /** Render only this line: there is nothing to list. */
  empty?: string | undefined;
  onkeydown?: (e: KeyboardEvent) => void;
  children?: Snippet;
}

let { label, empty, onkeydown, children }: Props = $props();
</script>

{#if empty !== undefined}
    <section class="spec-panel spec-panel--empty" aria-label={label}>
        <SpecEmpty quiet>{empty}</SpecEmpty>
    </section>
{:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section class="spec-panel" aria-label={label} role="group" {onkeydown}>
        {@render children?.()}
    </section>
{/if}

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

    .spec-panel--empty {
        padding: 10px 12px;
    }
</style>
