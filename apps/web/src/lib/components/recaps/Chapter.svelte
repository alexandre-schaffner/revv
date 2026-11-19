<script lang="ts">
import type { RecapPrEntry, RecapThemeSummary } from "@revv/shared";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import CaretUp from "phosphor-svelte/lib/CaretUp";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import { formatTheme, themeSlug } from "$lib/recaps/themes";
import InlineText from "./InlineText.svelte";
import PrRow from "./PrRow.svelte";

interface Props {
  theme: string;
  entries: ReadonlyArray<RecapPrEntry>;
  swatch: string;
  explanation?: RecapThemeSummary | undefined;
  teamNames?: readonly string[] | undefined;
  sectionKey?: string | undefined;
}
let { theme, entries, swatch, explanation, teamNames, sectionKey }: Props = $props();
let open = $state(false);
let evidenceOpen = $state(false);
const hasContext = $derived(
  Boolean(explanation?.context || explanation?.approach || explanation?.currentState),
);
</script>

<section class="chapter" id={sectionKey ? `${themeSlug(theme)}-${sectionKey}` : themeSlug(theme)} data-recap-theme={themeSlug(theme)}>
  <Collapsible bind:open>
    <CollapsibleTrigger class="chapter-header" aria-label="Understand {formatTheme(theme)}">
      <div class="chapter-title">
        <span class="dot" style="--swatch: {swatch}" aria-hidden="true"></span>
        <h2>{formatTheme(theme)}</h2>
      </div>
      <span class="chapter-meta">
        <span class="chapter-action">{open ? "Close" : "Understand"}</span>
        {#if open}<CaretUp size={12} aria-hidden="true" />{:else}<CaretDown size={12} aria-hidden="true" />{/if}
      </span>
    </CollapsibleTrigger>
    {#if teamNames?.length}
      <p class="chapter-teams">Topic also appears in {teamNames.join(", ")}</p>
    {/if}
    {#if explanation?.summary}
      <p class="chapter-summary"><InlineText text={explanation.summary} /></p>
    {/if}
    <CollapsibleContent>
      <div class="chapter-context">
        {#if explanation?.context}
          <div class="context-section">
            <h3>The idea</h3>
            <p><InlineText text={explanation.context} /></p>
          </div>
        {/if}
        {#if explanation?.approach}
          <div class="context-section">
            <h3>How it works</h3>
            <p><InlineText text={explanation.approach} /></p>
          </div>
        {/if}
        {#if explanation?.currentState}
          <div class="context-section">
            <h3>Where it stands</h3>
            <p><InlineText text={explanation.currentState} /></p>
          </div>
        {/if}
        {#if !hasContext}
          <p class="legacy-note">This earlier recap includes the supporting work below. Generate a new recap for the expanded topic context.</p>
        {/if}
        <Collapsible bind:open={evidenceOpen}>
          <CollapsibleTrigger class="evidence-trigger">
            <span>{evidenceOpen ? "Hide supporting work" : "Supporting work"}</span>
            {#if evidenceOpen}<CaretUp size={11} aria-hidden="true" />{:else}<CaretDown size={11} aria-hidden="true" />{/if}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="evidence">
              {#each entries as entry (entry.id)}<PrRow {entry} />{/each}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </CollapsibleContent>
  </Collapsible>
</section>

<style>
.chapter { padding: 1.5rem 0; scroll-margin-top: 1.5rem; }
.chapter:first-of-type { padding-top: 0; }
.chapter :global(.chapter-header) { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 1.5rem; width: 100%; padding: 0 0 .875rem; border: 0; border-bottom: 1px solid color-mix(in srgb, var(--color-text-muted) 22%, transparent); background: transparent; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.chapter :global(.chapter-header:hover) { color: var(--color-text-primary); }
.chapter :global(.chapter-header:focus-visible), .chapter :global(.evidence-trigger:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 4px; border-radius: 4px; }
.chapter-title { display: flex; align-items: center; gap: .625rem; min-width: 0; }
h2 { margin: 0; font-size: 1.375rem; font-weight: 600; letter-spacing: -.015em; color: var(--color-text-primary); text-wrap: balance; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--swatch); flex-shrink: 0; }
.chapter-meta { display: inline-flex; align-items: center; gap: .6rem; font-size: .7rem; color: var(--color-text-muted); }
.chapter-action { font-family: var(--font-mono); }
.chapter-summary { margin: .875rem 0 0; max-width: 620px; font-size: .9375rem; line-height: 1.55; color: var(--color-text-secondary); text-wrap: pretty; }
.chapter-teams { margin: .75rem 0 0; font-size: .8125rem; line-height: 1.5; color: var(--color-text-secondary); }
.chapter-context { display: flex; flex-direction: column; gap: 1.25rem; padding: 1.5rem 0 .25rem; }
h3 { margin: 0 0 .5rem; font-family: var(--font-mono); font-size: .6875rem; font-weight: 500; text-transform: uppercase; letter-spacing: .14em; color: var(--color-text-muted); }
.context-section p { margin: 0; max-width: 620px; font-size: .9375rem; line-height: 1.65; color: var(--color-text-secondary); text-wrap: pretty; }
.chapter :global(.evidence-trigger) { display: inline-flex; align-items: center; gap: .5rem; padding: .375rem 0; border: 0; background: transparent; color: var(--color-text-muted); font: inherit; font-size: .75rem; cursor: pointer; }
.chapter :global(.evidence-trigger:hover) { color: var(--color-text-primary); }
.evidence { padding-top: .5rem; }
.legacy-note { margin: 0; font-size: .8125rem; color: var(--color-text-muted); line-height: 1.55; }
@media (max-width: 600px) { .chapter :global(.chapter-header) { gap: .75rem; } .chapter-action { display: none; } }
</style>
