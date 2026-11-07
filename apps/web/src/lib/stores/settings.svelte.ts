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
import { apiErrorCode, call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
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

/**
 * The model catalog needs a session: the session lifecycle reads it when a
 * session starts and resets it when one ends.
 */
const models = createResource<AcpAgentId, ModelOption[]>({
  keepDataOnError: true,
  fetch: async (key, agent) => {
    try {
      const data = await call(
        api.api.settings.models.get({ query: { agent } }),
        "Couldn't load models",
      );
      return { status: "ok", data: data.models };
    } catch (e) {
      // Nothing was read, so nothing counts as loaded.
      if (apiErrorCode(e) === "UNAUTHORIZED") models.invalidate(key);
      throw e;
    }
  },
});

export function getSettings(): UserSettings {
  return loaded ?? DEFAULT_USER_SETTINGS;
}

export function isSettingsLoaded(): boolean {
  return loaded !== null;
}

export function getGithubHost(): string {
  return getSettings().githubHost;
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
  await persist({ githubHost: host, githubClientId: clientId }, {}, sendGithubConfig);
}

export async function setGithubConfigStrict(host: string, clientId: string): Promise<void> {
  await persist({ githubHost: host, githubClientId: clientId }, { strict: true }, sendGithubConfig);
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
    loaded = await call(api.api.settings.get(), "Couldn't load settings");
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
  await persist(patch, options, (p) => call(api.api.settings.put(p), "Couldn't save settings"));
}

// Onboarding picks the host before sign-in, so the host and client id have
// their own unauthenticated write; every other field needs a session.
const sendGithubConfig = (patch: Pick<UserSettings, "githubHost" | "githubClientId">) =>
  call(api.api.settings.github.put(patch), "Couldn't save settings");

async function persist<P extends SettingsUpdate>(
  patch: P,
  options: UpdateSettingsOptions,
  /** Throws on a refusal (see `call`). */
  send: (patch: P) => Promise<unknown>,
): Promise<void> {
  const previous = loaded;
  // Apply locally first, with the same rules the server applies, so
  // concurrent writes don't clobber each other when responses arrive out of
  // order. The response body is ignored for the same reason.
  if (loaded) loaded = applySettingsUpdate(loaded, patch);
  try {
    await send(patch);
  } catch (e) {
    if (options.strict) {
      loaded = previous;
      throw e;
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

/** Read every agent's catalog, so the pickers open without a round-trip. */
export async function fetchAllModels(): Promise<void> {
  await Promise.all(ACP_AGENT_IDS.map((id) => fetchModels(id)));
}

export function resetModels(): void {
  models.reset();
}

let agentStatus = $state<AgentStatusReport | null>(null);

export function getAgentStatus(): AgentStatusReport | null {
  return agentStatus;
}

export async function fetchAgentStatus(
  options: { refresh?: boolean } = {},
): Promise<AgentStatusReport | null> {
  try {
    agentStatus = await call(
      api.api.onboarding["agent-status"].get({ query: options.refresh ? { refresh: "1" } : {} }),
      "Couldn't read the agent's status",
    );
    return agentStatus;
  } catch {
    return agentStatus;
  }
}

// One real turn through the review path, run by the server
// (`ai/providers/agent-check.ts`). Explicit and user-triggered: it starts the agent and
// spends a few tokens, so opening Settings must never run it.

export async function runAgentCheck(agent: AcpAgentId): Promise<AgentCheckResult> {
  try {
    return await call(api.api.agent.check.post({ agent }), "Revv's service refused the check");
  } catch (err) {
    return { ok: false, error: thrownMessage(err), guidance: null };
  }
}
