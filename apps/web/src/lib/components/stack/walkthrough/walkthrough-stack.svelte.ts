// ── The stack, as a layer's walkthrough shows it ───────────────────────────
//
// Everything the walkthrough needs to know about the stack its PR sits in:
// whether it's stacked at all, where it sits, and which margin notes go
// beside which issue or chapter. Read off the stores and the page on screen;
// nothing is fetched here.

import { getPrById } from "$lib/stores/prs.svelte";
import { readStackPlace } from "../margin/place";
import { type MarginNotes, marginNotes, type StackPlace } from "../margin/stack-margin";

/** What the page shows that a margin note can be about. */
interface WalkthroughPage {
  /** Visible chapters, by semantic step index, with the files their blocks show. */
  readonly chapters: readonly { readonly index: number; readonly files: readonly string[] }[];
  /** Issues in page order. */
  readonly issues: readonly { readonly id: string; readonly filePath?: string | undefined }[];
}

export class WalkthroughStack {
  /**
   * GitHub stack membership comes from the poll, so the stack overview shows
   * before its own read lands and before any walkthrough exists.
   */
  isStacked: boolean;

  /** Null until the stack read lands, and for a stack of one. */
  place: StackPlace | null;

  /**
   * The rest of the stack, in the margin beside what it concerns: "Changed
   * again above" by the issue or chapter about a file an upper layer changes
   * too, "Relied on above" by the Overview. Null when the PR isn't stacked,
   * and then nothing renders any differently.
   */
  notes: MarginNotes | null;

  constructor(prId: () => string, page: () => WalkthroughPage) {
    this.isStacked = $derived(getPrById(prId())?.stack != null);
    this.place = $derived(this.isStacked ? readStackPlace(prId()) : null);
    this.notes = $derived.by(() => {
      if (!this.place) return null;
      const { issues, chapters } = page();
      return marginNotes(this.place, issues, chapters);
    });
  }
}
