import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  type AgentCheckResult,
  type AgentStatusReport,
  agentChangeUpdate,
  applySettingsUpdate,
  DEFAULT_USER_SETTINGS,
  getAgentCapabilities,
  getModelThinkingEfforts,
  type SettingsUpdate,
  THINKING_EFFORT_ORDER,
  type ThinkingEffort,
  type UserSettings,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { createResource } from "./resource";

export type ModelOption = { label: string; value: string };

const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  ultra: "Ultra",
  ultrathink: "Ultrathink",
  max: "Max",
  "extra-high": "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] =
  THINKING_EFFORT_ORDER.map((value) => ({ label: THINKING_EFFORT_LABELS[value], value }));

let loaded = $state<UserSettings | null>(null);
const models = createResource<AcpAgentId, ModelOption[]>({
  keepDataOnError: true,
  fetch: async (_key, agent) => {
    const { data, error } = await api.api.settings.models.get({ query: { agent } });
    if (error) return { status: "error", error: apiErrorMessage(error, "Couldn't load models") };
    return { status: "ok", data: data.models };
  },
});

export function getSettings(): UserSettings {
  return loaded ?? DEFAULT_USER_SETTINGS;
}

export function isSettingsLoaded(): boolean {
  return loaded !== null;
}

/**
 * `null` until settings have loaded. Onboarding reads this to choose between
 * the Welcome step (no host picked yet) and resuming at Sign-In.
 */
export function getGithubHost(): string | null {
  return loaded?.githubHost ?? null;
}

export function getGithubClientId(): string {
  return getSettings().githubClientId;
}

/**
 * Persist the host and its client ID together. Pass an empty `clientId` for
 * github.com so a previously-saved custom ID is cleared when switching back
 * to public GitHub.
 */
export async function setGithubConfig(host: string, clientId: string): Promise<void> {
  await updateSettings({ githubHost: host, githubClientId: clientId });
}

export async function setGithubConfigStrict(host: string, clientId: string): Promise<void> {
  await updateSettings({ githubHost: host, githubClientId: clientId }, { strict: true });
}

/**
 * The cached model list for `agent` (default: the selected one); empty until
 * fetched. `areModelsLoaded` tells "loading" from "genuinely empty".
 */
export function getAvailableModels(agent: AcpAgentId = getSettings().aiAgent): ModelOption[] {
  return models.data(agent) ?? [];
}

export function areModelsLoaded(agent: AcpAgentId): boolean {
  const { request } = models.entry(agent);
  return request.status === "ok" || request.status === "error";
}

// One definition for every picker (the chat bottom bar and Settings → AI
// agent), so the two can never offer different options.

/**
 * Review-model choices for `agent`: the live catalog for dynamic agents
 * (opencode), the registry's curated list otherwise. Excludes Auto — see
 * {@link isAutoModelOffered}.
 */
export function getReviewModelOptions(agent: AcpAgentId): ModelOption[] {
  const caps = getAgentCapabilities(agent);
  return caps.models === "dynamic"
    ? getAvailableModels(agent)
    : caps.models.map((m) => ({ label: m.label, value: m.value }));
}

/**
 * Auto needs the TypeSafe toggle on and a static depth ladder to route onto;
 * a live-fetched catalog has no ladder. See `ai/jev/routing.ts`.
 */
export function isAutoModelOffered(agent: AcpAgentId): boolean {
  return getSettings().jev.enabled && getAgentCapabilities(agent).models !== "dynamic";
}

/** Thinking-effort tiers `agent` supports, strongest first. Empty when it has no effort knob. */
export function getThinkingEffortOptions(agent: AcpAgentId): typeof THINKING_EFFORT_OPTIONS {
  const allowed = getModelThinkingEfforts(agent, getSettings().aiModel);
  return THINKING_EFFORT_OPTIONS.filter((o) => allowed.includes(o.value));
}

/** Effort Auto only needs TypeSafe on: effort routing skips the depth ladder. */
export function isAutoEffortOffered(): boolean {
  return getSettings().jev.enabled;
}

export async function fetchSettings(): Promise<void> {
  try {
    const { data } = await api.api.settings.get();
    if (data) loaded = data;
  } catch {
    // Unreachable server: keep what we have; the defaults render meanwhile.
  }
}

type UpdateSettingsOptions = {
  /**
   * Most settings controls are optimistic/best-effort. Recovery flows can opt
   * into strict mode to rollback local state and surface persistence failures.
   */
  strict?: boolean;
};

export async function updateSettings(
  patch: SettingsUpdate,
  options: UpdateSettingsOptions = {},
): Promise<void> {
  const previous = loaded;
  // Apply locally first, with the same rules the server applies, so
  // concurrent writes don't clobber each other when responses arrive out of
  // order. The response body is ignored for the same reason.
  if (loaded) loaded = applySettingsUpdate(loaded, patch);
  try {
    const { error } = await api.api.settings.put(patch);
    if (error) throw new Error(apiErrorMessage(error, "Couldn't save settings"));
  } catch (e) {
    if (options.strict) {
      loaded = previous;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}

/**
 * The patch for picking `agent`: its dependent model, suggestions model and
 * effort come along. Opencode's catalog is live, so its first fetched model
 * is used when there is one.
 */
export function agentChange(agent: AcpAgentId): SettingsUpdate {
  return agentChangeUpdate(
    getSettings(),
    agent,
    getAvailableModels(agent).map((m) => m.value),
  );
}

export async function fetchModels(agent: AcpAgentId): Promise<ModelOption[]> {
  await models.load(agent, agent);
  return models.data(agent) ?? [];
}

/**
 * Prefetch models for every supported agent in parallel. Call this once at
 * app start so agent/model dropdowns render instantly without round-trips.
 */
export async function fetchAllModels(): Promise<void> {
  await Promise.all(ACP_AGENT_IDS.map((id) => fetchModels(id)));
}

let agentStatus = $state<AgentStatusReport | null>(null);

export function getAgentStatus(): AgentStatusReport | null {
  return agentStatus;
}

export async function fetchAgentStatus(
  options: { refresh?: boolean } = {},
): Promise<AgentStatusReport | null> {
  try {
    const { data } = await api.api.onboarding["agent-status"].get({
      query: options.refresh ? { refresh: "1" } : {},
    });
    if (!data) return agentStatus;
    agentStatus = data;
    return data;
  } catch {
    return agentStatus;
  }
}

// One real turn through the review path, run by the server
// (`ai/providers/agent-check.ts`). Explicit and user-triggered: it starts the agent and
// spends a few tokens, so opening Settings must never run it.

export async function runAgentCheck(agent: AcpAgentId): Promise<AgentCheckResult> {
  try {
    const { data, error } = await api.api.agent.check.post({ agent });
    if (error) {
      return { ok: false, error: `Revv's service answered HTTP ${error.status}.`, guidance: null };
    }
    return data;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Revv's service is unreachable.",
      guidance: null,
    };
  }
}
