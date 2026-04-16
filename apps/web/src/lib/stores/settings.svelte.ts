import type { UserSettings } from '@rev/shared';
import { API_BASE_URL } from '@rev/shared';
import { api } from '$lib/api/client';
import type { ModelOption } from '$lib/constants/models';
import { authHeaders } from '$lib/utils/session-token';

let settings = $state<UserSettings | null>(null);
let isLoading = $state(false);
let availableModels = $state<ModelOption[]>([]);

export function getSettings(): UserSettings | null {
	return settings;
}

export function getIsLoading(): boolean {
	return isLoading;
}

export function getAvailableModels(): ModelOption[] {
	return availableModels;
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
	try {
		const { data } = await api.api.settings.put(partial as Record<string, unknown>);
		if (data) settings = data as UserSettings;
	} catch {
		// handle silently
	}
}

export function reset(): void {
	settings = null;
	isLoading = false;
	availableModels = [];
}

export async function fetchModels(): Promise<void> {
	try {
		const res = await fetch(`${API_BASE_URL}/api/settings/models`, {
			headers: authHeaders(),
		});
		if (!res.ok) return;
		const data = (await res.json()) as { models: ModelOption[] };
		availableModels = data.models;
	} catch {
		// handle silently — UI will show empty state
	}
}
