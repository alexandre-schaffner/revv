import { REVIEW_MODE, REVIEW_MODES, type WalkthroughMode } from "@revv/shared";

interface PerspectiveCopy {
  /** Menu label, and the footer's "<label> perspective". */
  readonly label: string;
  readonly description: string;
  /** The empty-state Generate pill. */
  readonly generateLabel: string;
}

/** UI copy per walkthrough perspective. Keyed on the mode, so adding one
 *  without its copy fails to compile. */
export const WALKTHROUGH_PERSPECTIVES: Record<WalkthroughMode, PerspectiveCopy> = {
  [REVIEW_MODE.reviewer]: {
    label: "Reviewer",
    description: "Reads it as someone else's change",
    generateLabel: "Generate walkthrough",
  },
  [REVIEW_MODE.author]: {
    label: "Author",
    description: "Reads it as your own, before review",
    generateLabel: "Generate self-review",
  },
};

/** The perspective menu, in `REVIEW_MODES` order. */
export const WALKTHROUGH_PERSPECTIVE_OPTIONS = REVIEW_MODES.map((value) => ({
  value,
  ...WALKTHROUGH_PERSPECTIVES[value],
}));
