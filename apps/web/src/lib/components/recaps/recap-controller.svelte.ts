import type { ProjectRecap, RecapPeriod } from "@revv/shared";
import { untrack } from "svelte";
import type { GenActionState } from "$lib/components/shared/GenActionBar.svelte";
import { recapWindowIsStale } from "$lib/recaps/period-window";
import {
  generateRecap,
  getRecapDetail,
  getRecapDetailLoading,
  getRecapPendingAction,
  loadRecap,
  regenerateRecap,
  stopRecap,
} from "$lib/recaps/store.svelte";
import {
  abortRecapStream,
  getRecapStreamEntry,
  mergeRecapStream,
  recapStreamEnded,
  resetRecapStream,
  streamRecap,
} from "$lib/recaps/stream.svelte";

/**
 * Everything a page showing one recap does with it: load the row, follow its
 * generation stream while it runs, re-read the row when the stream ends, and
 * turn its state into the action bar's. Construct during component init (it
 * registers effects); `getRecapId` may return null while nothing is chosen.
 */
export class RecapController {
  readonly #getRepoId: () => string;
  readonly #getRecapId: () => string | null;
  #generating = $state(false);

  constructor(getRepoId: () => string, getRecapId: () => string | null) {
    this.#getRepoId = getRepoId;
    this.#getRecapId = getRecapId;

    $effect(() => {
      const id = getRecapId();
      if (id) untrack(() => loadRecap(id));
    });

    $effect(() => {
      const id = getRecapId();
      if (id && this.stored?.status === "generating") void streamRecap(id);
    });

    $effect(() => {
      const id = getRecapId();
      return () => {
        if (id) abortRecapStream(id);
      };
    });

    // The row is committed before the stream announces its end (invariant 8),
    // so one read of it then is final, even when the broadcast was missed.
    let ended = false;
    $effect(() => {
      const id = getRecapId();
      const nowEnded = recapStreamEnded(this.stream);
      if (id && nowEnded && !ended) untrack(() => loadRecap(id, { force: true }));
      ended = nowEnded;
    });
  }

  get recapId(): string | null {
    return this.#getRecapId();
  }

  /** The row as last read or broadcast. */
  get stored(): ProjectRecap | null {
    const id = this.recapId;
    return id ? getRecapDetail(id) : null;
  }

  get stream() {
    const id = this.recapId;
    return id ? getRecapStreamEntry(id) : undefined;
  }

  /** The row with whatever the running generation has streamed since. */
  readonly recap = $derived.by((): ProjectRecap | null => {
    const stored = this.stored;
    return stored ? mergeRecapStream(stored, this.stream) : null;
  });

  get loading(): boolean {
    const id = this.recapId;
    return id ? getRecapDetailLoading(id) : false;
  }

  get pendingAction() {
    const id = this.recapId;
    return id ? getRecapPendingAction(id) : null;
  }

  get generating(): boolean {
    return this.#generating;
  }

  /** The recap covers a window that is no longer the current day or week. */
  readonly isStale = $derived.by(() => {
    const stored = this.stored;
    return stored ? recapWindowIsStale(stored) : false;
  });

  readonly actionState = $derived.by((): GenActionState | null => {
    switch (this.stored?.status) {
      case "generating":
        return { kind: "streaming" };
      case "stopped":
        return { kind: "resumable" };
      case "error":
        return { kind: "error" };
      // Rerunning a past window is only offered here: a date click in the
      // archive calendar goes straight to that date's recap.
      case "complete":
        return this.isStale ? { kind: "stale", label: "Rerun this recap" } : { kind: "complete" };
      default:
        return null;
    }
  });

  /**
   * Offer a recap of the current window while an older one is on screen,
   * whatever its status: Resume and Regenerate both rerun *that* window. Not
   * while a generation is in flight, when Stop is the only sensible action.
   */
  readonly offersCurrentWindow = $derived.by(() => {
    const stored = this.stored;
    return stored !== null && this.isStale && stored.status !== "generating";
  });

  /** Ask for the recap of the current window. */
  async generate(period: RecapPeriod): Promise<{ recapId: string } | null> {
    if (this.#generating) return null;
    this.#generating = true;
    try {
      return await generateRecap(this.#getRepoId(), period);
    } finally {
      this.#generating = false;
    }
  }

  async regenerate(): Promise<void> {
    const id = this.recapId;
    if (!id) return;
    resetRecapStream(id);
    await regenerateRecap(id);
  }

  async stop(): Promise<void> {
    const id = this.recapId;
    if (id) await stopRecap(id);
  }
}
