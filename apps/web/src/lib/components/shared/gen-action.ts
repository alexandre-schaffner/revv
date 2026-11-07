/** Lifecycle state of a generated document (walkthrough, recap), as its action bar shows it. */
export type GenActionState =
  | { kind: "empty"; label: string }
  | { kind: "streaming" }
  | { kind: "resumable" }
  | { kind: "error" }
  | { kind: "complete" }
  | { kind: "stale"; label: string };

/** An action in flight. */
export type GenPendingAction = "start" | "regenerate" | "resume" | "stop";

/** The caller's tooltips for the pills whose meaning depends on the document. */
export interface GenActionCopy {
  /** Regenerate, once a run is complete. */
  readonly regenerate: string;
  /** The stale pill. */
  readonly stale: string;
  /** From scratch; read only when the bar is given `onRegenerateFromScratch`. */
  readonly fromScratch?: { readonly complete: string; readonly stale: string };
}
