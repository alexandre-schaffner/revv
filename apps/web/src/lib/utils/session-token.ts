import { getToken } from '$lib/stores/auth.svelte';

/**
 * Get the current session token for API requests.
 * Reads from the auth store's reactive state.
 */
export function getSessionToken(): string {
	return getToken() ?? '';
}

/**
 * Build an Authorization header object suitable for fetch().
 * Returns an empty object if no token is available.
 */
export function authHeaders(): Record<string, string> {
	const token = getSessionToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}
