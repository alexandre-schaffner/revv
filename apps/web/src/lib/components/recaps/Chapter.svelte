<script lang="ts">
import type { RecapPrEntry } from "@revv/shared";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import Avatar from "./Avatar.svelte";
import InlineText from "./InlineText.svelte";
import PrRow from "./PrRow.svelte";
import { themeSlug } from "./themes";

interface Props {
  theme: string;
  entries: ReadonlyArray<RecapPrEntry>;
  swatch: string;
  summary?: string | undefined;
}

let { theme, entries, swatch, summary = undefined }: Props = $props();

let open = $state(true);
const sectionId = $derived(themeSlug(theme));

// Split entries by lifecycle state. The recap agent writes a single
// `add_pr_entry` call per PR with theme + verb + description; the server
// stamps `prState` based on whether the PR was archived or still open at
// recap time. Inside the chapter we render shipped entries first, then a
// thin "In progress" subhead and the active ones — keeping the editorial
// narrative ordered "what landed → what's coming".
const mergedEntries = $derived(entries.filter((e) => e.prState !== "open"));
const openEntries = $derived(entries.filter((e) => e.prState === "open"));

const countLabel = $derived.by(() => {
  if (mergedEntries.length === 0 && openEntries.length === 0) return "0 PRs";
  if (openEntries.length === 0) {
    return mergedEntries.length === 1 ? "1 shipped" : `${mergedEntries.length} shipped`;
  }
  if (mergedEntries.length === 0) {
    return openEntries.length === 1 ? "1 in progress" : `${openEntries.length} in progress`;
  }
  return `${mergedEntries.length} shipped · ${openEntries.length} in progress`;
});

interface AuthorGroup {
  readonly handle: string;
  readonly avatar: string | null;
  readonly entries: RecapPrEntry[];
  readonly firstPosition: number;
}

// Group entries by author within a subgroup. Author groups are ordered by
// the smallest `position` among their entries, so the agent's render order
// is preserved at the group level. Within a group, entries keep their
// original position order.
function groupByAuthor(items: ReadonlyArray<RecapPrEntry>): AuthorGroup[] {
  const map = new Map<string, AuthorGroup>();
  for (const e of items) {
    const key = e.prAuthorLogin || "?";
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(e);
      if (e.position < existing.firstPosition) {
        (existing as { firstPosition: number }).firstPosition = e.position;
      }
    } else {
      map.set(key, {
        handle: key,
        avatar: e.prAuthorAvatar,
        entries: [e],
        firstPosition: e.position,
      });
    }
  }
  const groups = Array.from(map.values());
  for (const g of groups) g.entries.sort((a, b) => a.position - b.position);
  groups.sort((a, b) => a.firstPosition - b.firstPosition);
  return groups;
}

const mergedGroups = $derived(groupByAuthor(mergedEntries));
const openGroups = $derived(groupByAuthor(openEntries));
</script>

<section class="chapter" id={sectionId}>
  <Collapsible bind:open>
    <CollapsibleTrigger class="chapter-header" aria-label="Toggle {theme} chapter">
      <div class="chapter-title">
        <span class="dot" style="--swatch: {swatch}" aria-hidden="true"></span>
        <h2>{theme}</h2>
      </div>
      <span class="chapter-meta">
        <span class="chapter-count">{countLabel}</span>
        <span class="chapter-chevron" data-state={open ? "open" : "closed"}>
          <CaretDown class="chapter-chevron-icon" aria-hidden="true" />
        </span>
      </span>
    </CollapsibleTrigger>
    <CollapsibleContent>
      {#if summary && summary.trim().length > 0}
        <p class="chapter-summary">
          <InlineText text={summary} />
        </p>
      {/if}
      <div class="chapter-groups">
        {#snippet authorGroupBlock(group: AuthorGroup, accent: "merged" | "open")}
          <div class="author-group" class:author-group--open={accent === "open"}>
            <div class="author-header">
              <Avatar handle={group.handle} avatarContent={group.avatar} size={22} />
              <span class="author-handle">{group.handle}</span>
              <span class="author-count">
                {group.entries.length === 1 ? "1 PR" : `${group.entries.length} PRs`}
              </span>
            </div>
            <div class="author-rows">
              {#each group.entries as entry (entry.id)}
                <PrRow {entry} />
              {/each}
            </div>
          </div>
        {/snippet}

        {#each mergedGroups as group (group.handle)}
          {@render authorGroupBlock(group, "merged")}
        {/each}

        {#if openGroups.length > 0}
          <div class="subgroup-divider">
            <span class="subgroup-label">In progress</span>
          </div>
          {#each openGroups as group (`open-${group.handle}`)}
            {@render authorGroupBlock(group, "open")}
          {/each}
        {/if}
      </div>
    </CollapsibleContent>
  </Collapsible>
</section>

<style>
.chapter {
  padding: 1.5rem 0;
  /* Offset for the sticky-ish hero so smooth-scroll lands the heading
     comfortably below the fold instead of jammed at viewport top. */
  scroll-margin-top: 1.5rem;
}

.chapter:first-of-type {
  padding-top: 0;
}

.chapter :global(.chapter-header) {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 1.5rem;
  padding-bottom: 0.875rem;
  border-bottom: 1px solid color-mix(in srgb, var(--color-text-muted) 22%, transparent);
  width: 100%;
  background: transparent;
  border-top: 0;
  border-left: 0;
  border-right: 0;
  text-align: left;
  cursor: pointer;
  appearance: none;
  font: inherit;
  color: inherit;
}

.chapter :global(.chapter-header:hover .chapter-chevron-icon) {
  color: var(--color-text-secondary);
}

.chapter-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.chapter-chevron {
  display: inline-grid;
  place-items: center;
  transition: transform var(--duration-snap) var(--ease-out-expo);
}

.chapter-chevron[data-state="closed"] {
  transform: rotate(-90deg);
}

.chapter :global(.chapter-chevron-icon) {
  width: 0.75rem;
  height: 0.75rem;
  color: var(--color-text-muted);
}

.chapter-title {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-width: 0;
}

.chapter-title h2 {
  margin: 0;
  font-size: 1.375rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--color-text-primary);
  text-transform: capitalize;
  text-wrap: balance;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  background: var(--swatch, var(--color-text-muted));
  flex-shrink: 0;
}

.chapter-count {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-text-muted);
}

.chapter-summary {
  margin: 0.875rem 0 0;
  max-width: 620px;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--color-text-secondary);
  text-wrap: pretty;
}

.chapter-groups {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding-top: 0.5rem;
}

.author-group {
  display: flex;
  flex-direction: column;
}

/* Subtle visual demotion on active-work rows so the "what landed" group
   reads as the primary content. Lower opacity is enough — preserving the
   verb tense + subhead context — without dimming so far that the entries
   feel inaccessible. */
.author-group--open {
  opacity: 0.78;
}

.author-header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem 0;
}

.author-handle {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-text-primary);
}

.author-count {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-left: auto;
}

.author-rows {
  display: flex;
  flex-direction: column;
  padding-left: calc(22px + 0.55rem);
}

/* Thin in-chapter divider. Functions like the chapter-header's bottom
   border at a smaller scale — same color recipe, smaller label. */
.subgroup-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-top: 0.5rem;
}

.subgroup-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: color-mix(in srgb, var(--color-text-muted) 18%, transparent);
}

.subgroup-label {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--color-text-muted);
}

@media (max-width: 600px) {
  .chapter :global(.chapter-header) {
    grid-template-columns: 1fr auto;
  }
  .chapter-title {
    grid-column: 1;
  }
  .chapter-meta {
    grid-column: 2;
    justify-self: end;
  }
}
</style>
