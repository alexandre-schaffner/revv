import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  type AgentStatusReport,
  getAgentCapabilities,
  type UserSettings,
} from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import {
  getDefaultModel,
  getDefaultSuggestionsModel,
  type ModelOption,
} from "$lib/constants/models";
import { invalidateSuggestions } from "$lib/stores/suggestions.svelte";
import { authHeaders } from "$lib/utils/session-token";

/** The agent that drives chat / walkthrough / recap (single registry id). */
export function resolveChatAgentId(s: UserSettings | null): AcpAgentId {
  return s?.aiAgent ?? "opencode";
}

/** A per-agent record seeded with `make()` for every registry agent. */
function byAgent<T>(make: () => T): Record<AcpAgentId, T> {
  return Object.fromEntries(ACP_AGENT_IDS.map((id) => [id, make()])) as Record<AcpAgentId, T>;
}

let settings = $state<UserSettings | null>(null);
let _isLoading = $state(false);
let modelsByAgent = $state<Record<AcpAgentId, ModelOption[]>>(byAgent(() => []));
let modelsLoadedByAgent = $state<Record<AcpAgentId, boolean>>(byAgent(() => false));
let modelsInFlight: Partial<Record<AcpAgentId, Promise<ModelOption[]>>> = {};

export function getSettings(): UserSettings | null {
  return settings;
}

/**
 * GitHub host the app authenticates against. Returns `null` until the
 * settings file has been fetched at least once. The onboarding flow reads
 * this to decide whether to start at the Welcome step (no host yet) or
 * resume at Sign-In (host already picked).
 */
export function getGithubHost(): string | null {
  return settings?.githubHost ?? null;
}

/**
 * BYO OAuth/App client ID for a user-added GitHub Enterprise host. Empty for
 * github.com. The onboarding host step writes this alongside `githubHost`
 * when the user points Revv at their own GHE instance.
 */
export function getGithubClientId(): string {
  return settings?.githubClientId ?? "";
}

/**
 * Persist the host and its client ID together. Pass an empty `clientId` for
 * github.com so a previously-saved custom ID is cleared when switching back
 * to public GitHub.
 */
export async function setGithubConfig(host: string, clientId: string): Promise<void> {
  await updateSettings({ githubHost: host, githubClientId: clientId });
}

/**
 * Persist GitHub host/client ID and surface failures to callers that need a
 * hard recovery path, such as reauth after an upgrade. Most settings controls
 * intentionally use `updateSettings`, which remains best-effort/optimistic.
 */
export async function setGithubConfigStrict(host: string, clientId: string): Promise<void> {
  const partial = { githubHost: host, githubClientId: clientId };
  const previous = settings;
  if (settings) settings = { ...settings, ...partial };

  const res = await fetch(`${API_BASE_URL}/api/settings`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) {
    settings = previous;
    const detail = await res.text().catch(() => "");
    throw new Error(detail.trim() || `Failed to save GitHub settings (HTTP ${res.status})`);
  }
}

/**
 * Read the cached model list for a given agent (or the currently selected
 * agent when `agent` is omitted). Returns an empty array if models have not
 * been fetched yet — callers can use `areModelsLoaded` to disambiguate
 * "loading" from "genuinely empty".
 */
export function getAvailableModels(agent?: AcpAgentId): ModelOption[] {
  const a = agent ?? settings?.aiAgent ?? "opencode";
  return modelsByAgent[a] ?? [];
}

export function areModelsLoaded(agent: AcpAgentId): boolean {
  return modelsLoadedByAgent[agent] ?? false;
}

export async function fetchSettings(): Promise<void> {
  _isLoading = true;
  try {
    const { data } = await api.api.settings.get();
    if (data) settings = data as UserSettings;
  } catch {
    // handle silently
  } finally {
    _isLoading = false;
  }
}

/**
 * Shape accepted by `updateSettings`. Top-level fields are individually
 * optional. `recap` and `cache` are recursively partial so callers can
 * patch a single nested field (e.g. `{ cache: { enabled: true } }`)
 * without spreading the whole sub-object. The server deep-merges them
 * against the current values.
 */
export type SettingsUpdate = Partial<Omit<UserSettings, "id" | "recap" | "cache">> & {
  recap?: Partial<UserSettings["recap"]>;
  cache?: Partial<Omit<UserSettings["cache"], "signing">> & {
    signing?: Partial<UserSettings["cache"]["signing"]>;
  };
};

export async function updateSettings(partial: SettingsUpdate): Promise<void> {
  // Optimistic local merge — apply the partial immediately so concurrent calls
  // (e.g. model + context-window in the same popover session) don't clobber each
  // other when server responses arrive out of order. `recap` and `cache` are
  // deep-merged so a sub-field patch doesn't blow away the other sub-fields.
  if (settings) {
    const mergedRecap = partial.recap ? { ...settings.recap, ...partial.recap } : settings.recap;
    const mergedCache = partial.cache
      ? {
          ...settings.cache,
          ...partial.cache,
          signing: partial.cache.signing
            ? { ...settings.cache.signing, ...partial.cache.signing }
            : settings.cache.signing,
        }
      : settings.cache;
    settings = {
      ...settings,
      ...partial,
      recap: mergedRecap,
      cache: mergedCache,
    } as UserSettings;
  }
  // Drop the cached right-panel suggestions whenever the model or agent
  // changes — the previously-fetched prompts were generated by a
  // different model and the user expects the new selection to take effect
  // on the next PR open without a refresh. Server keeps its own cache
  // keyed on `(prId, headSha, model)` so the client miss simply lands on
  // a different cache row.
  if ("aiSuggestionsModel" in partial || "aiAgent" in partial) {
    invalidateSuggestions();
  }
  try {
    await api.api.settings.put(partial as Record<string, unknown>);
    // Intentionally ignore the response body: merging a full settings object
    // here would reintroduce the race described above.
  } catch {
    // handle silently
  }
}

export function reset(): void {
  settings = null;
  _isLoading = false;
  modelsByAgent = byAgent(() => []);
  modelsLoadedByAgent = byAgent(() => false);
  modelsInFlight = {};
  agentStatus = null;
}

/**
 * Fetch the model list for a specific agent and cache it. Concurrent calls for
 * the same agent de-dupe onto a single in-flight request so rapid agent toggles
 * don't thrash the server.
 */
export async function fetchModels(agent: AcpAgentId): Promise<ModelOption[]> {
  const existing = modelsInFlight[agent];
  if (existing) return existing;

  const url = `${API_BASE_URL}/api/settings/models?agent=${encodeURIComponent(agent)}`;
  const promise = (async () => {
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) return modelsByAgent[agent] ?? [];
      const data = (await res.json()) as { models: ModelOption[] };
      const list = data.models ?? [];
      modelsByAgent = { ...modelsByAgent, [agent]: list };
      modelsLoadedByAgent = { ...modelsLoadedByAgent, [agent]: true };
      return list;
    } catch {
      return modelsByAgent[agent] ?? [];
    } finally {
      delete modelsInFlight[agent];
    }
  })();

  modelsInFlight[agent] = promise;
  return promise;
}

/**
 * Prefetch models for every supported agent in parallel. Call this once at
 * app start so agent/model dropdowns render instantly without round-trips.
 */
export async function fetchAllModels(): Promise<void> {
  await Promise.all(ACP_AGENT_IDS.map((id) => fetchModels(id)));
}

/**
 * Cascade for the agent picker. There is a single `aiAgent` now (it drives
 * chat, walkthrough, and recap), so picking an ACP agent must:
 *   - set `aiAgent`;
 *   - re-pick `aiModel` from that agent's capability catalog (dynamic = opencode
 *     → cached list / default) so the shared model stays compatible;
 *   - re-pick the low-cost `aiSuggestionsModel` default for the new agent;
 *   - clamp `aiThinkingEffort` to a tier the new agent supports.
 * Side-effect free — callers pass the result to `updateSettings()`.
 */
export function cascadeChatAgentChange(acpId: AcpAgentId): SettingsUpdate {
  const caps = getAgentCapabilities(acpId);
  const update: SettingsUpdate = {
    aiAgent: acpId,
    aiSuggestionsModel: getDefaultSuggestionsModel(acpId),
  };

  if (caps.models === "dynamic") {
    const cached = getAvailableModels(acpId);
    update.aiModel = cached[0]?.value ?? getDefaultModel(acpId);
  } else {
    const first = caps.models[0];
    if (first) update.aiModel = first.value;
  }

  if (caps.thinkingEfforts.length > 0) {
    const cur = getSettings()?.aiThinkingEffort;
    if (!cur || !caps.thinkingEfforts.includes(cur)) {
      const fallback = caps.thinkingEfforts.includes("high") ? "high" : caps.thinkingEfforts[0];
      if (fallback) update.aiThinkingEffort = fallback;
    }
  }

  return update;
}

// ── Agent status ──────────────────────────────────────────────────────────────
// Cached one-shot detection snapshot — per-agent installed + authed + login
// command, plus whether this host supports the embedded PTY login. Used by the
// onboarding agent step to render the picker tags and the adaptive CTA. Stays
// null until `fetchAgentStatus()` runs, since first render has nothing useful to
// show.

let agentStatus = $state<AgentStatusReport | null>(null);

export function getAgentStatus(): AgentStatusReport | null {
  return agentStatus;
}

export async function fetchAgentStatus(): Promise<AgentStatusReport | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/onboarding/agent-status`, {
      headers: authHeaders(),
    });
    if (!res.ok) return agentStatus;
    const data = (await res.json()) as AgentStatusReport;
    agentStatus = data;
    return data;
  } catch {
    return agentStatus;
  }
}
