import { authClient } from '$lib/auth-client';
import * as prs from '$lib/stores/prs.svelte';
import * as settings from '$lib/stores/settings.svelte';
import { openAddRepoDialog } from '$lib/stores/sidebar.svelte';
import * as sync from '$lib/services/sync';
import { goto } from '$app/navigation';
import { API_BASE_URL } from '@revv/shared';

const storedToken =
	typeof localStorage !== 'undefined' ? localStorage.getItem('rev_session_token') : null;

let token = $state<string | null>(storedToken);
let user = $state<{ name: string; email: string; image?: string; githubLogin?: string | null } | null>(null);
let isLoading = $state(false);
let error = $state<string | null>(null);

let deviceFlow = $state<{
	userCode: string;
	verificationUri: string;
	deviceCode: string;
	interval: number;
	expiresAt: number;
} | null>(null);
let isPolling = $state(false);
let pollTimer: ReturnType<typeof setTimeout> | null = null;

let isAuthenticated = $derived(token !== null && token.length > 0);

export function getIsAuthenticated(): boolean {
	return isAuthenticated;
}

export function getError(): string | null {
	return error;
}

export function getDeviceFlow(): typeof deviceFlow {
	return deviceFlow;
}

export function getIsPolling(): boolean {
	return isPolling;
}

export function setToken(newToken: string): void {
	token = newToken;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem('rev_session_token', newToken);
	}
}

export function clearToken(): void {
	token = null;
	user = null;
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem('rev_session_token');
	}
}

export async function signIn(): Promise<void> {
	error = null;
	isLoading = true;
	try {
		const res = await fetch(`${API_BASE_URL}/api/auth/device/init`, { method: 'POST' });
		if (!res.ok) throw new Error('Failed to initiate sign-in');
		const data = (await res.json()) as {
			device_code: string;
			user_code: string;
			verification_uri: string;
			expires_in: number;
			interval: number;
		};
		deviceFlow = {
			userCode: data.user_code,
			verificationUri: data.verification_uri,
			deviceCode: data.device_code,
			interval: data.interval ?? 5,
			expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
		};
		try {
			const { isTauri } = await import('$lib/utils/platform');
			if (isTauri()) {
				const { openUrl } = await import('@tauri-apps/plugin-opener');
				await openUrl(data.verification_uri);
			} else {
				window.open(data.verification_uri, '_blank');
			}
		} catch {
			// Opening browser is best-effort
		}
		startPolling();
	} catch (e) {
		error = `Failed to start sign-in: ${e}`;
	} finally {
		isLoading = false;
	}
}

function startPolling(): void {
	if (!deviceFlow) return;
	isPolling = true;
	schedulePoll(deviceFlow.interval);
}

function schedulePoll(intervalSeconds: number): void {
	pollTimer = setTimeout(() => poll(), intervalSeconds * 1000);
}

async function poll(): Promise<void> {
	if (!deviceFlow) return;

	if (Date.now() > deviceFlow.expiresAt) {
		error = 'Sign-in timed out. Please try again.';
		cancelSignIn();
		return;
	}

	try {
		const res = await fetch(`${API_BASE_URL}/api/auth/device/poll`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_code: deviceFlow.deviceCode }),
		});
		const data = (await res.json()) as {
			status?: string;
			token?: string;
			error?: string;
			interval?: number;
		};

		if (data.status === 'pending') {
			schedulePoll(deviceFlow.interval);
			return;
		}

		if (data.status === 'slow_down') {
			const newInterval = data.interval ?? deviceFlow.interval + 5;
			deviceFlow = { ...deviceFlow, interval: newInterval };
			schedulePoll(newInterval);
			return;
		}

		if (data.status === 'success' && data.token) {
			setToken(data.token);
			deviceFlow = null;
			isPolling = false;
			await loadUser();
			await focusWindow();
			if (prs.getRepositories().length === 0) {
				openAddRepoDialog();
			}
			return;
		}

		// Error cases
		error =
			data.error === 'expired'
				? 'Sign-in timed out. Please try again.'
				: data.error === 'access_denied'
					? 'Sign-in was cancelled.'
					: 'Sign-in failed. Please try again.';
		cancelSignIn();
	} catch {
		// Network error — retry after current interval
		if (deviceFlow) schedulePoll(deviceFlow.interval);
	}
}

export function cancelSignIn(): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
	deviceFlow = null;
	isPolling = false;
}

export async function loadUser(): Promise<void> {
	if (!token) return;
	isLoading = true;
	try {
		const session = await authClient.getSession();
		if (session.data?.user) {
			const u = session.data.user;
			user = {
				name: u.name,
				email: u.email,
				...(u.image != null ? { image: u.image } : {}),
			};
			// Fetch GitHub login separately — better-auth doesn't expose it.
			try {
				const res = await fetch(`${API_BASE_URL}/api/user/identity`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (res.ok) {
					const data = (await res.json()) as { login: string | null };
					if (user) user = { ...user, githubLogin: data.login };
				}
			} catch {
				// best-effort
			}
		} else {
			clearToken();
		}
	} catch {
		clearToken();
	} finally {
		isLoading = false;
	}
}

export async function signOut(): Promise<void> {
	sync.stopPolling();

	try {
		await fetch(`${API_BASE_URL}/api/auth/revoke-and-sign-out`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});
	} catch {
		// Revocation may fail — proceed with local cleanup
	}

	clearToken();
	prs.reset();
	settings.reset();

	await goto('/');
}

export function getToken(): string | null {
	return token;
}

export function getUser(): { name: string; email: string; image?: string; githubLogin?: string | null } | null {
	return user;
}

/** Current user's GitHub login, or null if not yet loaded or missing. */
export function getCurrentUserLogin(): string | null {
	return user?.githubLogin ?? null;
}

/**
 * Role of the current user relative to a PR's author.
 * 'coder' when the PR author matches; 'reviewer' otherwise; 'unknown' if either side is missing.
 */
export function getUserRoleForPr(prAuthorLogin: string | null | undefined): 'reviewer' | 'coder' | 'unknown' {
	const me = user?.githubLogin;
	if (!me || !prAuthorLogin) return 'unknown';
	return me === prAuthorLogin ? 'coder' : 'reviewer';
}

export function getIsLoading(): boolean {
	return isLoading;
}

/** Bring the app window to the foreground after auth completes. */
export async function focusWindow(): Promise<void> {
	try {
		const { isTauri } = await import('$lib/utils/platform');
		if (isTauri()) {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			await getCurrentWindow().setFocus();
		} else {
			window.focus();
		}
	} catch {
		// Focus is best-effort
	}
}
