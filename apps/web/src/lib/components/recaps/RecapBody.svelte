<script lang="ts">
import type { ProjectRecap, RecapSourceScope } from "@revv/shared";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import Warning from "phosphor-svelte/lib/Warning";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import { gsapPress } from "$lib/motion";
import {
  buildChapters,
  buildThemePalette,
  formatTheme,
  paletteLookup,
  scrollToTheme,
} from "$lib/recaps/themes";
import Chapter from "./Chapter.svelte";
import InlineText from "./InlineText.svelte";
import { groupRecapTopics, type RecapTeamSection, type RecapViewFilter } from "./recap-view";

interface Props {
  recap: ProjectRecap;
  filter?: RecapViewFilter;
  fallbackTeams?: RecapSourceScope["teams"];
  usesCurrentTeams?: boolean;
}

let { recap, filter = {}, fallbackTeams = [], usesCurrentTeams = false }: Props = $props();
let collapsedTeams = $state(new Set<string>());

// Allowlist sanitizer: escape everything, then re-emit only <strong>/<em>.
function sanitizeLedeHtml(raw: string): string {
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/&lt;strong&gt;/gi, "<strong>")
    .replace(/&lt;\/strong&gt;/gi, "</strong>")
    .replace(/&lt;em&gt;/gi, "<em>")
    .replace(/&lt;\/em&gt;/gi, "</em>");
}

const ledeHtml = $derived(sanitizeLedeHtml(recap.lede));
const chapters = $derived(buildChapters(recap.entries));
const palette = $derived(buildThemePalette(chapters.map((c) => c.theme)));

// Theme labels in summaries are normalized server-side (lowercase + trim +
// single-space) — matching the same normalization on `entries[].theme` — so
// a direct lookup keyed on theme matches the chapter that buildChapters
// produced. Themes without a summary fall back to no chapter lede.
const summaryByTheme = $derived(new Map(recap.themeSummaries.map((s) => [s.theme, s])));
const teams = $derived(recap.sourceScope?.teams?.length ? recap.sourceScope.teams : fallbackTeams);
const sections = $derived(groupRecapTopics(recap, filter, teams));
const grouped = $derived(teams.length > 0);
const watchpoints = $derived(
  recap.themeSummaries.filter((summary) => summary.worthWatching?.trim()),
);
function setTeamOpen(key: string, open: boolean): void {
  const next = new Set(collapsedTeams);
  if (open) next.delete(key);
  else next.add(key);
  collapsedTeams = next;
}
$effect(() => {
  function onRevealTheme(event: Event): void {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    const section = sections.find((section) => section.themes.includes(event.detail));
    if (section) setTeamOpen(section.key, true);
  }
  document.addEventListener("recap:reveal-theme", onRevealTheme);
  return () => document.removeEventListener("recap:reveal-theme", onRevealTheme);
});
</script>

<div class="body">
  {#if recap.lede}
    <span class="eyebrow">Overview</span>
    <!-- The lede is a custom inline-only sanitized string (strong/em),
         styled as display text by `.lede` below. It is intentionally not
         inside a `.prose` surface, so it gets none of the typography-plugin
         body styling. -->
    <p class="lede">{@html ledeHtml}</p>
  {/if}

  {#if watchpoints.length}
    <section class="watchpoints" aria-labelledby="watchpoints-title">
      <h2 id="watchpoints-title"><Warning size={15} />Worth watching if something breaks</h2>
      <ul>
        {#each watchpoints as point (point.theme)}
          <li>
            <button class="watchpoint-topic" onclick={() => scrollToTheme(point.theme)}>{formatTheme(point.theme)}</button>
            <p><InlineText text={point.worthWatching ?? ""} /></p>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if grouped && sections.length > 0}
    <p class="team-caption">Topics are grouped by their contributors’ GitHub teams{usesCurrentTeams || !recap.sourceScope?.teams?.length ? " today" : " when this recap was generated"}. Shared topics keep their overall explanation; Supporting work shows each team’s PRs and authors. Membership can overlap.</p>
    <nav class="team-nav" aria-label="Teams in this recap">
      {#each sections as section (section.key)}
        <button type="button" use:gsapPress aria-expanded={!collapsedTeams.has(section.key)} aria-controls="recap-team-content-{section.key}" onclick={() => setTeamOpen(section.key, collapsedTeams.has(section.key))}><UsersThree size={12} />{section.name}{#if collapsedTeams.has(section.key)}<CaretRight size={11} />{:else}<CaretDown size={11} />{/if}</button>
      {/each}
    </nav>
    {#each sections as section (section.key)}
      <section class="team-section" id="recap-team-{section.key}">
        <Collapsible open={!collapsedTeams.has(section.key)} onOpenChange={(open) => setTeamOpen(section.key, open)}>
          <header class="team-heading">
            <h2><CollapsibleTrigger class="team-trigger"><span>{section.name}</span><span class="team-meta">{section.themes.length} {section.themes.length === 1 ? "topic" : "topics"}{#if collapsedTeams.has(section.key)}<CaretRight size={14} />{:else}<CaretDown size={14} />{/if}</span></CollapsibleTrigger></h2>
            <p>{section.key === "other" ? "Contributions by authors with no matching GitHub team in these repositories." : `Contributions by members of ${section.org} / ${section.name}`}</p>
          </header>
          <CollapsibleContent id="recap-team-content-{section.key}">
            {#each chapters.filter((chapter) => section.themes.includes(chapter.theme)) as chapter (chapter.theme)}
              {@render topic(chapter, section)}
            {/each}
          </CollapsibleContent>
        </Collapsible>
      </section>
    {/each}
  {:else}
    {#each chapters as chapter (chapter.theme)}{@render topic(chapter)}{/each}
  {/if}
</div>

{#snippet topic(chapter: (typeof chapters)[number], section?: RecapTeamSection)}
  <Chapter theme={chapter.theme} entries={section?.entriesByTheme.get(chapter.theme) ?? chapter.entries} swatch={paletteLookup(palette, chapter.theme)} explanation={summaryByTheme.get(chapter.theme)} teamNames={section?.teamsByTheme.get(chapter.theme)?.filter((name) => name !== `${section.org} / ${section.name}`)} sectionKey={section?.key} />
{/snippet}

<style>
.watchpoints { margin: .5rem 0 1rem; padding: 1.25rem 1.5rem; border: 1px solid color-mix(in srgb, var(--color-warning) 25%, var(--color-border-subtle)); border-radius: .75rem; background: color-mix(in srgb, var(--color-warning) 4%, var(--color-bg-secondary)); }
.watchpoints h2 { display: flex; align-items: center; gap: .5rem; margin: 0 0 1rem; font-size: var(--text-ui); font-weight: 600; color: var(--color-text-primary); }
.watchpoints h2 :global(svg) { color: var(--color-warning); flex-shrink: 0; }
.watchpoints ul { display: flex; flex-direction: column; gap: 1rem; margin: 0; padding: 0; list-style: none; }
.watchpoint-topic { padding: 0; background: transparent; border: 0; font: inherit; font-size: var(--text-ui); font-weight: 600; color: var(--color-text-primary); text-align: left; cursor: pointer; }
.watchpoint-topic:hover { text-decoration: underline; }
.watchpoints p { margin: .25rem 0 0; font-size: var(--text-ui); line-height: 1.6; color: var(--color-text-secondary); }
.team-caption { margin: 0; max-width: 70ch; font-size: var(--text-ui); line-height: 1.6; color: var(--color-text-secondary); }
.team-nav { display: flex; flex-wrap: wrap; gap: .5rem; padding: .25rem 0 1.25rem; border-bottom: 1px solid var(--color-border-subtle); }
.team-nav button { display: inline-flex; align-items: center; gap: .4rem; padding: .4rem .7rem; border: 1px solid var(--color-border-subtle); border-radius: 999px; background: var(--color-bg-secondary); font: inherit; font-size: var(--text-xs); color: var(--color-text-secondary); cursor: pointer; }
.team-nav button:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
.team-section { scroll-margin-top: 1.5rem; }
.team-heading { display: flex; flex-direction: column; gap: .5rem; margin: .75rem 0 1.5rem; }
.team-heading h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--color-text-primary); }
.team-heading :global(.team-trigger) { display: flex; align-items: center; justify-content: space-between; gap: 1rem; width: 100%; border: 0; padding: .5rem 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
.team-heading :global(.team-trigger:hover) { color: var(--color-accent); }
.team-heading :global(.team-trigger:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 3px; border-radius: .25rem; }
.team-meta { display: inline-flex; align-items: center; gap: .5rem; flex-shrink: 0; font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }
.team-heading p { margin: 0; max-width: 70ch; font-size: var(--text-ui); line-height: 1.5; color: var(--color-text-secondary); }
.watchpoint-topic:focus-visible, .team-nav button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }

.body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}

.eyebrow {
  font-family: var(--font-sans);
  font-size: var(--text-ui);
  font-weight: 500;
  color: var(--color-text-subtle);
}

.lede {
  margin: 0;
  font-size: var(--text-lg);
  letter-spacing: var(--text-lg--letter-spacing);
  /* A standfirst, not a heading: regular weight, so the bold it carries
     still reads as emphasis. */
  font-weight: 400;
  line-height: 1.55;
  color: var(--color-text-primary);
  max-width: 680px;
  text-wrap: pretty;
}

.lede :global(strong) {
  font-weight: 600;
  color: var(--color-text-primary);
}

.lede :global(em) {
  font-style: italic;
  color: var(--color-text-secondary);
}
</style>
