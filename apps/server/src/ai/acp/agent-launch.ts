// ── Which agent, model and effort run for a purpose ──────────────────────────
//
// The one resolution. Its result keys the ACP connection pool and, for chat,
// the chat session row, so two call sites can never disagree about which warm
// agent or which conversation is "the chat".

import {
  ACP_AGENTS,
  type AcpAgentId,
  getAgentCapabilities,
  isAutoSentinel,
  resolveThinkingEffort,
  type ThinkingEffort,
  type UserSettings,
} from "@revv/shared";
import { Effect } from "effect";
import { SettingsService } from "../../services/Settings";
import type { GenerationLaunchOverride } from "../jev/routing";

export interface AgentLaunch {
  readonly agent: AcpAgentId;
  readonly model: string;
  readonly thinkingEffort: ThinkingEffort | undefined;
}

/**
 * - `chat`: the right-pane chat and the merge-conflict agent.
 * - `review`: walkthrough generation, which alone may carry a sized override.
 * - `recap`: project recaps, on the recap agent setting.
 * - `brief`: stack briefs.
 * - `suggestions`: one-shot prompts (chat suggestions, stack headlines) on the cheap model.
 */
export type AgentPurpose = "chat" | "review" | "recap" | "brief" | "suggestions";

function isStaticCatalogModel(model: string): boolean {
  return ACP_AGENTS.some(
    ({ capabilities: { models } }) => models !== "dynamic" && models.some((m) => m.value === model),
  );
}

/**
 * A model valid for the agent's catalog: `configured` (or `sized`, when the
 * setting is Auto) if the agent offers it, else `fallback`. The recap agent
 * can differ from the one the model setting was picked for, so a model from
 * another catalog must never reach the agent. opencode's catalog is dynamic,
 * so its models are taken on trust, except an id from another agent's static
 * catalog, which can only be a leftover of that agent.
 */
export function resolveGenerationModel(
  agent: AcpAgentId,
  configured: string | null | undefined,
  sized?: string | null,
  fallback: string = getAgentCapabilities(agent).defaultModel,
): string {
  const { models } = getAgentCapabilities(agent);
  const pinned = isAutoSentinel(configured) ? (sized ?? null) : configured;
  if (!pinned) return fallback;
  if (models === "dynamic") return isStaticCatalogModel(pinned) ? fallback : pinned;
  return models.some((m) => m.value === pinned) ? pinned : fallback;
}

function suggestionsLaunch(settings: UserSettings, agent: AcpAgentId): AgentLaunch | null {
  if (settings.aiSuggestionsModel.length === 0) return null;
  return {
    agent,
    model: resolveGenerationModel(
      agent,
      settings.aiSuggestionsModel,
      null,
      getAgentCapabilities(agent).suggestionsModel,
    ),
    thinkingEffort: resolveThinkingEffort(settings.aiThinkingEffort),
  };
}

function generationLaunch(
  settings: UserSettings,
  agent: AcpAgentId,
  purpose: Exclude<AgentPurpose, "suggestions"> | "check",
  override?: GenerationLaunchOverride | null,
): AgentLaunch {
  return {
    agent,
    model: resolveGenerationModel(agent, override?.model ?? settings.aiModel),
    thinkingEffort:
      purpose === "check"
        ? "low"
        : // Sized effort for Auto, the user's pin otherwise.
          resolveThinkingEffort(settings.aiThinkingEffort, override?.thinkingEffort ?? null),
  };
}

/**
 * The launch for `agent` under `settings`. `suggestions` is `null` when the
 * suggestions model is cleared, which turns one-shot prompts off. `check` is
 * Settings' agent test: the review model at low effort, for whichever agent
 * the user is testing.
 */
export function agentLaunchFor(
  settings: UserSettings,
  agent: AcpAgentId,
  purpose: "suggestions",
): AgentLaunch | null;
export function agentLaunchFor(
  settings: UserSettings,
  agent: AcpAgentId,
  purpose: Exclude<AgentPurpose, "suggestions"> | "check",
  override?: GenerationLaunchOverride | null,
): AgentLaunch;
export function agentLaunchFor(
  settings: UserSettings,
  agent: AcpAgentId,
  purpose: AgentPurpose | "check",
  override?: GenerationLaunchOverride | null,
): AgentLaunch | null {
  return purpose === "suggestions"
    ? suggestionsLaunch(settings, agent)
    : generationLaunch(settings, agent, purpose, override);
}

/** {@link agentLaunchFor} on the current settings and the configured agent for `purpose`. */
export function resolveAgentLaunch(
  purpose: "suggestions",
): Effect.Effect<AgentLaunch | null, never, SettingsService>;
export function resolveAgentLaunch(
  purpose: Exclude<AgentPurpose, "suggestions">,
  override?: GenerationLaunchOverride | null,
): Effect.Effect<AgentLaunch, never, SettingsService>;
export function resolveAgentLaunch(
  purpose: AgentPurpose,
  override?: GenerationLaunchOverride | null,
): Effect.Effect<AgentLaunch | null, never, SettingsService> {
  return Effect.gen(function* () {
    const settingsService = yield* SettingsService;
    const settings = yield* settingsService.getSettings();
    const agent =
      purpose === "recap"
        ? yield* settingsService.resolveRecapAgent()
        : yield* settingsService.resolveAgent();
    return purpose === "suggestions"
      ? suggestionsLaunch(settings, agent)
      : generationLaunch(settings, agent, purpose, override);
  });
}
