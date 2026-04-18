import type { AiAgent, UserSettings } from '@revv/shared';
import { API_BASE_URL } from '@revv/shared';
import { api } from '$lib/api/client';
import type { ModelOption } from '$lib/constants/models';
import { authHeaders } from '$lib/utils/session-token';

let settings = $state<UserSettings | null>(null);
let isLoading = $state(false);
let modelsByAgent = $state<Record<AiAgent, ModelOption[]>>({
	opencode: [],
	claude: [],
});
let modelsLoadedByAgent = $state<Record<AiAgent, boolean>>({
	opencode: false,
	claude: false,
});
let modelsInFlight: Partial<Record<AiAgent, Promise<ModelOption[]>>> = {};

export function getSettings(): UserSettings | null {
	return settings;
}

export function getIsLoading(): boolean {
	return isLoading;
}

/**
 * Read the cached model list for a given agent (or the currently selected
 * agent when `agent` is omitted). Returns an empty array if models have not
 * been fetched yet — callers can use `areModelsLoaded` to disambiguate
 * "loading" from "genuinely empty".
 */
export function getAvailableModels(agent?: AiAgent): ModelOption[] {
	const a = agent ?? ((settings?.aiAgent as AiAgent) ?? 'opencode');
	return modelsByAgent[a] ?? [];
}

export function areModelsLoaded(agent: AiAgent): boolean {
	return modelsLoadedByAgent[agent] ?? false;
}

export async function fetchSettings(): Promise<void> {
	isLoading = true;
	try {
		const { data } = await api.api.settings.get();
		if (data) settings = data as UserSettings;
	} catch {
		// handle silently
	} finally {
		isLoading = false;
	}
}

export async function updateSettings(partial: Partial<Omit<UserSettings, 'id'>>): Promise<void> {
	// Optimistic local merge — apply the partial immediately so concurrent calls
	// (e.g. model + context-window in the same popover session) don't clobber each
	// other when server responses arrive out of order.
	if (settings) {
		settings = { ...settings, ...partial } as UserSettings;
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
	isLoading = false;
	modelsByAgent = { opencode: [], claude: [] };
	modelsLoadedByAgent = { opencode: false, claude: false };
	modelsInFlight = {};
}

/**
 * Fetch the model list for a specific agent and cache it. Concurrent calls for
 * the same agent de-dupe onto a single in-flight request so rapid agent toggles
 * don't thrash the server.
 */
export async function fetchModels(agent: AiAgent): Promise<ModelOption[]> {
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
	await Promise.all([fetchModels('opencode'), fetchModels('claude')]);
}
