<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Terminal from "phosphor-svelte/lib/Terminal";
import { Shimmer } from "$lib/components/ai/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";

interface Props {
  command: string;
  summary: string;
  active?: boolean;
}

let { command, summary, active = false }: Props = $props();

let open = $state(false);

const displayCommand = $derived(command.split("\n")[0] ?? command);
const truncatedSummary = $derived(
  displayCommand.length > 80 ? `${displayCommand.slice(0, 77)}…` : displayCommand,
);
</script>

<div
  class="shell-activity"
  data-state={open ? "open" : "closed"}
>
  <Collapsible bind:open>
    <CollapsibleTrigger class="shell-trigger" aria-label="Shell command: {summary}">
      <div class="shell-trigger-main">
        <span class="shell-trigger-label">
          <Terminal class="shell-trigger-icon" aria-hidden="true" />
          <Shimmer active={active}>Shell</Shimmer>
        </span>
        <span class="shell-trigger-summary">{`$ ${truncatedSummary}`}</span>
      </div>
      <CaretDown class="shell-chevron" aria-hidden="true" />
    </CollapsibleTrigger>

    <CollapsibleContent class="shell-content">
      <div class="shell-command-block">
        <pre class="shell-command-code">{command}</pre>
      </div>
    </CollapsibleContent>
  </Collapsible>
</div>

<style>
  .shell-activity {
    display: block;
    width: 100%;
    overflow: hidden;
    border-radius: 0.375rem;
    animation: shell-activity-in var(--duration-quick) var(--ease-out-expo) both;
  }

  .shell-activity :global(.shell-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem;
    padding: 0.125rem 0;
    text-align: left;
  }

  .shell-trigger-main {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.45;
  }

  .shell-trigger-label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .shell-trigger-icon {
    width: 0.875rem;
    height: 0.875rem;
    color: var(--color-text-muted);
  }

  .shell-trigger-summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: color-mix(in srgb, var(--color-text-muted) 72%, transparent);
  }

  .shell-activity :global(.shell-chevron) {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform var(--duration-snap) var(--ease-out-expo);
  }

  .shell-activity[data-state="open"] :global(.shell-chevron) {
    transform: rotate(180deg);
  }

  .shell-activity :global(.shell-content) {
    overflow: hidden;
  }

  .shell-activity :global(.shell-content[data-state="closed"]) {
    display: none;
  }

  .shell-command-block {
    padding: 0.375rem 0 0.125rem 1.75rem;
  }

  .shell-command-code {
    margin: 0;
    padding: 0.5rem 0.625rem;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.5;
    border-radius: 0.375rem;
    background: var(--color-bg-tertiary);
    color: var(--color-text-primary);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  @keyframes shell-activity-in {
    from {
      opacity: 0;
      filter: blur(2px);
      transform: translateY(0.25rem);
    }
    to {
      opacity: 1;
      filter: blur(0);
      transform: translateY(0);
    }
  }
</style>
