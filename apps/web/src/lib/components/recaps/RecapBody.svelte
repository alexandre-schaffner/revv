<script lang="ts">
import type { ProjectRecap } from "@revv/shared";
import Chapter from "./Chapter.svelte";
import { buildChapters, buildThemePalette, paletteLookup } from "./themes";

interface Props {
  recap: ProjectRecap;
}

let { recap }: Props = $props();

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
const summaryByTheme = $derived.by(() => {
  const map = new Map<string, string>();
  for (const s of recap.themeSummaries) {
    if (s.summary.trim().length > 0) map.set(s.theme, s.summary);
  }
  return map;
});
</script>

<div class="body">
  {#if recap.lede}
    <span class="eyebrow">Overview</span>
    <!-- not-prose: the lede is a custom inline-only sanitized string (strong/em),
         intentionally styled as display text rather than typography-plugin body. -->
    <p class="lede not-prose">{@html ledeHtml}</p>
  {/if}

  {#each chapters as chapter (chapter.theme)}
    <Chapter
      theme={chapter.theme}
      entries={chapter.entries}
      swatch={paletteLookup(palette, chapter.theme)}
      summary={summaryByTheme.get(chapter.theme)}
    />
  {/each}
</div>

<style>
.body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}

.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--color-text-muted);
}

.lede {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 500;
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
