import type { UserSettings } from '@rev/shared';
import { api } from '$lib/api/client';

let settings = $state<UserSettings | null>(null);
let isLoading = $state(false);

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

export function getSettings(): UserSettings | null {
	return settings;
}

export function getIsLoading(): boolean {
	return isLoading;
}

export function reset(): void {
	settings = null;
	isLoading = false;
}
