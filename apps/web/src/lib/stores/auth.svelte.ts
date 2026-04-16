import { authClient } from '$lib/auth-client';
import { isTauri } from '$lib/utils/platform';
import { API_BASE_URL } from '@rev/shared';
import * as prs from '$lib/stores/prs.svelte';
import * as settings from '$lib/stores/settings.svelte';
import * as sync from '$lib/services/sync';
import { goto } from '$app/navigation';

const storedToken =
	typeof localStorage !== 'undefined' ? localStorage.getItem('rev_session_token') : null;

let token = $state<string | null>(storedToken);
let user = $state<{ name: string; email: string; image?: string } | null>(null);
let isLoading = $state(false);

/** Sign-in flow state */
type SignInPhase = 'idle' | 'waiting';
let phase = $state<SignInPhase>('idle');
let error = $state<string | null>(null);
let pollTimer = $state<ReturnType<typeof setInterval> | null>(null);

let isAuthenticated = $derived(token !== null && token.length > 0);

export function getIsAuthenticated(): boolean {
	return isAuthenticated;
}

export function getPhase(): SignInPhase {
	return phase;
}

export function getError(): string | null {
	return error;
}

export function setToken(newToken: string): void {
	token = newToken;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem('rev_session_token', newToken);
	}
	// If we were waiting for auth, we're done
	phase = 'idle';
	stopPolling();
}

export function clearToken(): void {
	token = null;
	user = null;
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem('rev_session_token');
	}
}

/**
 * Initiates the GitHub OAuth sign-in flow.
 *
 * Opens the server's OAuth redirect endpoint in an external browser (Tauri)
 * or the current window (browser dev mode), then polls for the resulting
 * token as a fallback for when deep-links don't fire.
 */
export async function signIn(): Promise<void> {
	error = null;
	phase = 'waiting';

	const signInUrl = `${API_BASE_URL}/api/auth/sign-in/github`;

	try {
		if (isTauri()) {
			const { openUrl } = await import('@tauri-apps/plugin-opener');
			await openUrl(signInUrl);
		} else {
			window.open(signInUrl, '_blank');
		}
	} catch (e) {
		error = `Failed to open sign-in page: ${e}`;
		phase = 'idle';
		return;
	}

	// Start polling /api/auth/pending-token as a fallback
	startPolling();
}

export function cancelSignIn(): void {
	phase = 'idle';
	error = null;
	stopPolling();
}

function startPolling(): void {
	stopPolling();
	pollTimer = setInterval(async () => {
		try {
			const res = await fetch(`${API_BASE_URL}/api/auth/pending-token`);
			const data = (await res.json()) as { token: string | null };
			if (data.token) {
				setToken(data.token);
				await loadUser();
				await focusWindow();
			}
		} catch {
			// Silently retry on next interval
		}
	}, 1500);
}

/** Bring the app window to the foreground after auth completes. */
async function focusWindow(): Promise<void> {
	try {
		if (isTauri()) {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			await getCurrentWindow().setFocus();
		} else {
			window.focus();
		}
	} catch {
		// Focus is best-effort — ignore failures
	}
}

function stopPolling(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
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
		} else {
			// Token is invalid — clear it
			clearToken();
		}
	} catch {
		clearToken();
	} finally {
		isLoading = false;
	}
}

export async function signOut(): Promise<void> {
	// Stop background sync and disconnect WebSocket first
	sync.stopPolling();

	// Revoke GitHub token and invalidate session — don't block local cleanup on failure
	try {
		await fetch(`${API_BASE_URL}/api/auth/revoke-and-sign-out`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});
	} catch {
		// Revocation may fail (expired session, network error) — proceed with local cleanup
	}

	// Clear all local state
	clearToken();
	prs.reset();
	settings.reset();

	await goto('/');
}

export function getToken(): string | null {
	return token;
}

export function getUser(): { name: string; email: string; image?: string } | null {
	return user;
}

export function getIsLoading(): boolean {
	return isLoading;
}
