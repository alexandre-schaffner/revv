// ── ACP session config options ───────────────────────────────────────────────
//
// ACP has two ways for an agent to publish per-session selections: the older
// `modes` field (`session/set_mode`) and the generic `configOptions` list
// (`session/set_config_option`). opencode (1.18+ and 2) moved everything onto
// the latter — its agents (build / plan) are a `mode`-category select and its
// model catalog is a `model`-category select — and no longer sends `modes` at
// all. These pure helpers read both shapes so the connection layer can treat
// them uniformly.

import type {
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

/** The `session/new` / `session/load` response fields these helpers read. */
export interface SessionConfigSource {
  readonly modes?: SessionModeState | null | undefined;
  readonly configOptions?: readonly SessionConfigOption[] | null | undefined;
}

export interface ResolvedSessionModes {
  readonly modes: SessionModeState | null;
  /**
   * The config option the modes came from, switched with
   * `session/set_config_option`. Absent when they came from `modes` (switched
   * with `session/set_mode`) or the agent advertises none.
   */
  readonly modeConfigId?: string;
}

/** First `select` config option in a category, if the agent advertises one. */
function findSelectConfigOption(
  options: readonly SessionConfigOption[] | null | undefined,
  category: string,
): SelectConfigOption | undefined {
  return options?.find(
    (option): option is SelectConfigOption =>
      option.type === "select" && option.category === category,
  );
}

/** A select option's choices, flattening grouped option lists. */
function selectChoices(option: SelectConfigOption): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

/**
 * Resolve a session's modes. Prefers the dedicated `modes` field and falls
 * back to a `mode`-category config option (opencode), reshaped into the same
 * `SessionModeState` so plan-mode detection has one input shape.
 */
export function resolveSessionModes(res: SessionConfigSource): ResolvedSessionModes {
  if (res.modes) return { modes: res.modes };
  const option = findSelectConfigOption(res.configOptions, "mode");
  if (!option) return { modes: null };
  return {
    modes: {
      currentModeId: option.currentValue,
      availableModes: selectChoices(option).map((choice) => ({
        id: choice.value,
        name: choice.name,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    },
    modeConfigId: option.id,
  };
}

export type ModelSelection =
  | { readonly kind: "none" }
  | { readonly kind: "current" }
  | { readonly kind: "unavailable"; readonly configId: string }
  | { readonly kind: "switch"; readonly configId: string };

/**
 * Decide how to apply a Revv-selected model to a session through its
 * `model`-category config option: already current, switchable, or not in the
 * agent's catalog. `none` means the agent advertises no model option at all.
 */
export function planModelSelection(
  options: readonly SessionConfigOption[] | null | undefined,
  model: string,
): ModelSelection {
  const option = findSelectConfigOption(options, "model");
  if (!option) return { kind: "none" };
  if (option.currentValue === model) return { kind: "current" };
  if (!selectChoices(option).some((choice) => choice.value === model)) {
    return { kind: "unavailable", configId: option.id };
  }
  return { kind: "switch", configId: option.id };
}

// Matched against a mode's id and name only, never its description: Claude
// Code's `default` mode is described as "Always ask before making changes".
const PLAN_MODE_EXACT = /^(plan|architect|ask|read.?only)$/;
const PLAN_MODE_HINT = /(plan|architect|read.?only)/;

/**
 * Pick the read-only/plan/architect mode from the agent's advertised modes. A
 * mode whose id or name is exactly one of those wins; otherwise the first
 * whose id or name mentions one. `ask` only counts exactly, since Claude
 * Code's `dontAsk` would otherwise match.
 */
export function findPlanModeId(modes: SessionModeState | null): string | undefined {
  if (!modes) return undefined;
  const labels = (mode: SessionModeState["availableModes"][number]): string[] => [
    mode.id.toLowerCase(),
    mode.name.toLowerCase(),
  ];
  return (
    modes.availableModes.find((mode) => labels(mode).some((l) => PLAN_MODE_EXACT.test(l))) ??
    modes.availableModes.find((mode) => labels(mode).some((l) => PLAN_MODE_HINT.test(l)))
  )?.id;
}

/**
 * The mode to leave a resumed session in for a non-plan turn. Agents keep a
 * session's mode across turns (opencode 2 documents it), so a session whose
 * previous turn ran in plan mode would stay read-only. Returns the first
 * non-plan mode when the session currently sits in the plan mode.
 */
export function modeToExitPlan(modes: SessionModeState | null): string | undefined {
  const planModeId = findPlanModeId(modes);
  if (!modes || !planModeId || modes.currentModeId !== planModeId) return undefined;
  return modes.availableModes.find((mode) => mode.id !== planModeId)?.id;
}
