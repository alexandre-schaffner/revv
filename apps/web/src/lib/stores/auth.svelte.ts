import { authClient } from '$lib/auth-client';
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
type SignInPhase = 'idle' | 'waiting' | 'code-ready';
let phase = $state<SignInPhase>('idle');
let error = $state<string | null>(null);

/** Device code flow state */
let deviceCode = $state<string | null>(null);
let userCode = $state<string | null>(null);
let verificationUri = $state<string | null>(null);
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

export function getUserCode(): string | null {
	return userCode;
}

export function getVerificationUri(): string | null {
	return verificationUri;
}

export function setToken(newToken: string): void {
	token = newToken;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem('rev_session_token', newToken);
	}
	phase = 'idle';
	clearDeviceState();
}

export function clearToken(): void {
	token = null;
	user = null;
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem('rev_session_token');
	}
}

/**
 * Initiates the GitHub Device Code OAuth flow.
 *
 * Requests a device code from the server, then starts polling for authorization.
 * The user must visit the verification URI and enter the user code on GitHub.
 */
export async function signIn(): Promise<void> {
	error = null;
	phase = 'waiting';

	try {
		const res = await fetch(`${API_BASE_URL}/api/auth/device/code`, { method: 'POST' });
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			error = data.error ?? `Request failed: ${res.status}`;
			phase = 'idle';
			return;
		}

		const data = (await res.json()) as {
			device_code: string;
			user_code: string;
			verification_uri: string;
			expires_in: number;
			interval: number;
		};

		deviceCode = data.device_code;
		userCode = data.user_code;
		verificationUri = data.verification_uri;
		phase = 'code-ready';

		const pollIntervalMs = Math.max(data.interval * 1000, 5000);
		startPolling(data.device_code, pollIntervalMs);
	} catch (e) {
		error = `Failed to start sign-in: ${e}`;
		phase = 'idle';
	}
}

export function cancelSignIn(): void {
	phase = 'idle';
	error = null;
	clearDeviceState();
}

function clearDeviceState(): void {
	stopPolling();
	deviceCode = null;
	userCode = null;
	verificationUri = null;
}

function startPolling(currentDeviceCode: string, intervalMs: number): void {
	stopPolling();

	let currentInterval = intervalMs;

	const poll = async () => {
		try {
			const res = await fetch(`${API_BASE_URL}/api/auth/device/poll`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ device_code: currentDeviceCode }),
			});

			const data = (await res.json()) as
				| { status: 'pending' }
				| { status: 'slow_down' }
				| { status: 'expired' }
				| { status: 'denied' }
				| { status: 'error'; message: string }
				| { status: 'success'; token: string };

			switch (data.status) {
				case 'pending':
					// Keep polling — no change needed
					break;
				case 'slow_down':
					// Double the interval and reschedule
					stopPolling();
					currentInterval = currentInterval * 2;
					pollTimer = setInterval(poll, currentInterval);
					break;
				case 'success':
					setToken(data.token);
					await loadUser();
					await focusWindow();
					break;
				case 'expired':
					error = 'Authorization expired. Please try again.';
					phase = 'idle';
					clearDeviceState();
					break;
				case 'denied':
					error = 'Authorization was denied.';
					phase = 'idle';
					clearDeviceState();
					break;
				case 'error':
					error = data.message;
					phase = 'idle';
					clearDeviceState();
					break;
			}
		} catch {
			// Silently retry on next interval
		}
	};

	pollTimer = setInterval(poll, currentInterval);
}

/** Bring the app window to the foreground after auth completes. */
async function focusWindow(): Promise<void> {
	try {
		const { isTauri } = await import('$lib/utils/platform');
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
