<script lang="ts">
/*
 * Callers paint the row through custom properties on a wrapper
 * (`--c-gutter-color`, `--c-gutter-flash`, `--c-row-bg`, …) and fill its
 * columns with snippets.
 */
import CaretRight from "phosphor-svelte/lib/CaretRight";
import type { Snippet } from "svelte";
import { fromAction } from "svelte/attachments";
import * as Collapsible from "$lib/components/ui/collapsible";
import { type EnterParams, enterOnce } from "$lib/motion";

interface Props {
  open: boolean;
  onToggle: () => void;
  /** Session-unique row identity; the row's one-shot motion is keyed on it. */
  motionKey: string;
  /** Posted to GitHub: dimmed, can't expand, success gutter. */
  submitted?: boolean;
  ariaLabel?: string;
  /** Called with the trigger on mount and with null on unmount, for keyboard nav. */
  onTriggerRef?: ((el: HTMLElement | null) => void) | undefined;
  icon?: Snippet;
  label?: Snippet;
  /** Shown after the label while the row is closed. */
  preview?: Snippet;
  trailing?: Snippet;
  content?: Snippet;
}

let {
  open,
  onToggle,
  motionKey,
  submitted = false,
  ariaLabel,
  onTriggerRef,
  icon,
  label,
  preview,
  trailing,
  content,
}: Props = $props();

let triggerRef = $state<HTMLElement | null>(null);

$effect(() => {
  onTriggerRef?.(triggerRef);
  return () => onTriggerRef?.(null);
});

function focusTriggerOnPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement | null;
  if (target?.closest('[data-slot="checkbox"]')) return;
  if (e.currentTarget instanceof HTMLElement) {
    e.currentTarget.focus({ preventScroll: true });
  }
}
</script>

<li
    class="spec-row"
    class:spec-row--submitted={submitted}
    {@attach !submitted &&
        fromAction(enterOnce, (): EnterParams => ({ key: `${motionKey}:nudge`, look: "nudge" }))}
>
    <Collapsible.Root
        {open}
        onOpenChange={(next: boolean) => {
            if (submitted) return;
            if (next !== open) {
                triggerRef?.focus({ preventScroll: true });
                onToggle();
            }
        }}
    >
        <Collapsible.Trigger
            class="spec-row-trigger"
            disabled={submitted}
            aria-disabled={submitted}
            aria-label={ariaLabel}
            bind:ref={triggerRef}
            onpointerdown={focusTriggerOnPointerDown}
        >
            <span class="spec-row-gutter" aria-hidden="true">
                {#if !submitted}
                    <span
                        class="spec-row-flash"
                        use:enterOnce={{ key: `${motionKey}:flash`, look: "flash" }}
                    ></span>
                {/if}
            </span>

            <span class="spec-row-icon">
                {#if icon}{@render icon()}{/if}
            </span>

            <span class="spec-row-label">
                {#if label}{@render label()}{/if}
                {#if !open && preview}
                    <span class="spec-row-preview">{@render preview()}</span>
                {/if}
            </span>

            <span class="spec-row-trailing">
                {#if trailing}{@render trailing()}{/if}
            </span>

            <span
                class="spec-row-chevron"
                class:spec-row-chevron--open={open}
                class:spec-row-chevron--hidden={submitted}
                aria-hidden="true"
            >
                <CaretRight size={14} />
            </span>
        </Collapsible.Trigger>

        {#if content}
            <Collapsible.Content>
                {@render content()}
            </Collapsible.Content>
        {/if}
    </Collapsible.Root>
</li>

<style>
    .spec-row {
        list-style: none;
        position: relative;
        display: block;
    }

    :global(.spec-row-trigger) {
        display: grid;
        grid-template-columns:
            2ch
            minmax(0, 1fr)
            auto
            16px;
        align-items: center;
        gap: 8px;
        width: 100%;
        overflow: hidden;
        min-height: 36px;
        padding: 0 10px 0 16px;
        background: transparent;
        border: none;
        border-radius: 0;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition:
            background var(--duration-snap) var(--ease-soft),
            opacity var(--duration-snap) var(--ease-soft);
    }

    :global(.spec-row-trigger:disabled),
    :global(.spec-row-trigger[aria-disabled="true"]) {
        cursor: default;
    }

    :global(.spec-row-trigger:focus-visible) {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
    }

    :global(.spec-row-trigger:hover:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--c-row-bg, var(--color-bg-elevated)) 50%,
            transparent
        );
    }

    .spec-row--submitted :global(.spec-row-trigger) {
        opacity: 0.55;
    }

    .spec-row-gutter {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: var(--gutter-w, 2px);
        background: var(--c-gutter-color, var(--color-border));
        transition: background var(--duration-quick) var(--ease-soft);
    }

    .spec-row--submitted .spec-row-gutter {
        background: var(--c-gutter-color-submitted, var(--color-success));
    }

    /* Lit by a one-shot tween when the row first shows. */
    .spec-row-flash {
        position: absolute;
        inset: 0;
        opacity: 0;
        background: var(--c-gutter-flash, var(--c-gutter-color));
        box-shadow: 0 0 6px
            color-mix(in srgb, var(--c-gutter-color, var(--color-text-primary)) 50%, transparent);
    }

    .spec-row-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--c-icon-color, var(--color-text-muted));
    }

    .spec-row-label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-mono);
        font-size: 13px;
        font-weight: 600;
        color: var(--c-label-color, var(--color-text-primary));
        white-space: nowrap;
        letter-spacing: 0.01em;
        min-width: 0;
        overflow: hidden;
    }

    .spec-row-preview {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        flex: 1 1 0;
        font-weight: 400;
        letter-spacing: 0;
    }

    .spec-row-trailing {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        min-width: 0;
    }

    .spec-row-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-muted);
        transition: transform var(--duration-snap) var(--ease-out-expo);
    }

    .spec-row-chevron--open {
        transform: rotate(90deg);
    }

    .spec-row-chevron--hidden {
        visibility: hidden;
    }
</style>
