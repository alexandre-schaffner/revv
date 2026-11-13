import { readStackPlace } from "$lib/stacks/place";
import { type MarginNotes, marginNotes, type StackPlace } from "$lib/stacks/stack-margin";
import { getPrById } from "$lib/stores/prs.svelte";

interface WalkthroughPage {
  readonly chapters: readonly { readonly index: number; readonly files: readonly string[] }[];
  readonly issues: readonly { readonly id: string; readonly filePath?: string | undefined }[];
}

export class WalkthroughStack {
  isStacked: boolean;

  place: StackPlace | null;

  notes: MarginNotes | null;

  constructor(prId: () => string, page: () => WalkthroughPage) {
    this.isStacked = $derived(getPrById(prId())?.stack != null);
    this.place = $derived(readStackPlace(prId()));
    this.notes = $derived.by(() => {
      if (!this.place) return null;
      const { issues, chapters } = page();
      return marginNotes(this.place, issues, chapters);
    });
  }
}
