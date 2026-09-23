/**
 * Closed set of independently switchable System One hooks. The compiler
 * boundary for every consumer — server mappings, validation, and settings UI
 * all use `JevHookKey`, so adding a hook can't silently skip a surface.
 */
export const JEV_HOOK_KEYS = [
  "autoModel",
  "risk",
  "filePriority",
  "issueScoring",
  "issueSeverity",
  "hideLowSignal",
  "artifactQuality",
  "proseVoice",
  "adjudicateContinuations",
] as const;

export type JevHookKey = (typeof JEV_HOOK_KEYS)[number];

export const JEV_HOOK_DEFAULTS = {
  autoModel: false,
  risk: false,
  filePriority: false,
  issueScoring: false,
  issueSeverity: false,
  hideLowSignal: true,
  artifactQuality: false,
  proseVoice: false,
  adjudicateContinuations: false,
} as const satisfies Record<JevHookKey, boolean>;
export type JevHookSettings = Record<JevHookKey, boolean>;

export interface JevSettings extends JevHookSettings {
  /** Master switch. Off disables every hook regardless of its saved value. */
  enabled: boolean;
  /** Derived server-side from the keyring. Never accepted in a settings patch. */
  hasApiKey: boolean;
}

export interface JevHookDefinition {
  readonly label: string;
  readonly hint: string;
  readonly ariaLabel: string;
}

/** User-facing metadata, exhaustively keyed by {@link JevHookKey}. */
export const JEV_HOOKS = {
  risk: {
    label: "Risk tier",
    hint: "Set low / medium / high before the agent starts, so every model gets the same issue budget and depth contract.",
    ariaLabel: "Use TypeSafe for the risk tier",
  },
  autoModel: {
    label: "Automatic sizing",
    hint: "Offer Auto for the model and reasoning effort, sized independently for each pull request.",
    ariaLabel: "Use TypeSafe for automatic sizing",
  },
  filePriority: {
    label: "Rank the changed files",
    hint: "Score each file for reviewer attention and hand the agent a reading order. This rides along in the sizing request.",
    ariaLabel: "Rank changed files with TypeSafe",
  },
  issueScoring: {
    label: "Check flagged issues",
    hint: "Check each concern for grounding, scope, actionability, and duplication, then retract concerns that do not hold up.",
    ariaLabel: "Check flagged issues with TypeSafe",
  },
  issueSeverity: {
    label: "Calibrate issue severity",
    hint: "Use one fixed rubric for info / warning / critical instead of letting severity drift between agent models and runs.",
    ariaLabel: "Calibrate issue severity with TypeSafe",
  },
  hideLowSignal: {
    label: "Collapse low-signal issues",
    hint: "Keep weak concerns available behind a disclosure while leaving the filtered count visible.",
    ariaLabel: "Collapse low-signal issues",
  },
  artifactQuality: {
    label: "Hold artifacts to the craft bar",
    hint: "Reject interactive artifacts without live state, something to vary, or a verdict.",
    ariaLabel: "Check artifact quality with TypeSafe",
  },
  proseVoice: {
    label: "Check the writing voice",
    hint: "Sample the opening chapters for preamble, hedging, and padding, then return advisory feedback during the run.",
    ariaLabel: "Check prose voice with TypeSafe",
  },
  adjudicateContinuations: {
    label: "Stop doomed retries",
    hint: "Ask before spending an automatic continuation when the partial run is unlikely to recover.",
    ariaLabel: "Adjudicate automatic continuations with TypeSafe",
  },
} as const satisfies Record<JevHookKey, JevHookDefinition>;

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  enabled: false,
  hasApiKey: false,
  ...JEV_HOOK_DEFAULTS,
};
