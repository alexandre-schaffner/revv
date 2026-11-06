// Identity of the signed-in user, the device-flow sign-in, and the list of
// accounts on this machine. The session lifecycle that acts on them (start,
// switch, end) lives in `$lib/session/lifecycle.svelte`; this store imports
// no other store.

import { isMaintainerLogin, type UserUpdatedEnvelope } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { authClient } from "$lib/auth-client";
import { clearToken, getToken, setToken } from "$lib/session/token.svelte";
import { surfaceWindow } from "$lib/utils/surface-window";

const LOAD_USER_RETRY_DELAY_MS = 1000;
const LOAD_USER_MAX_RETRIES = 10;

interface User {
  id: string;
  name: string;
  email: string;
  image?: string;
  githubLogin?: string | null;
  onboardedAt?: string | null;
}

let user = $state<User | null>(null);
let isLoading = $state(false);
/**
 * Set once `/api/user/identity` has been *attempted* for the current session
 * — on success and on failure alike, so a flaky identity call can never wedge
 * a caller that waits on it. Distinguishes "GitHub login not fetched yet" from
 * "fetched, and there is none", which `getCurrentUserLogin()` reports
 * identically. See {@link hasAttemptedIdentityLoad}.
 */
let identityAttempted = $state(false);
let isSwitching = $state(false);
let error = $state<string | null>(null);

export type SignInErrorCode = "invalid_github_client_id" | "missing_github_client_id";
let signInErrorCode = $state<SignInErrorCode | null>(null);

let deviceFlow = $state<{
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
  host?: string;
  clientId?: string;
} | null>(null);
export type LocalAccount = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  accounts: Array<{
    host: string;
    githubLogin: string | null;
    avatarUrl: string | null;
  }>;
};

let localAccounts = $state<LocalAccount[]>([]);
let loadUserRetryTimer: ReturnType<typeof setTimeout> | null = null;
let loadUserRetryAttempts = $state(0);
let authRestoreError = $state<string | null>(null);
let authRestoreExhausted = $state(false);

/**
 * Set when the active account's GitHub token is invalid and could not be
 * silently refreshed. Drives the blocking re-sign-in modal. Hydrated from
 * `/api/user/identity` on boot and updated live by the `auth:reauth-required`
 * / `auth:reauth-cleared` SSE handlers. Cleared on successful re-auth.
 */
let reauthRequired = $state<{ host: string | null; githubLogin: string | null } | null>(null);

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function getReauthRequired(): { host: string | null; githubLogin: string | null } | null {
  return reauthRequired;
}

export function onAuthReauthRequired(data: { host: string; githubLogin: string | null }): void {
  reauthRequired = { host: data.host, githubLogin: data.githubLogin };
}

export function onAuthReauthCleared(): void {
  reauthRequired = null;
}

export function getLocalAccounts(): LocalAccount[] {
  return localAccounts;
}

const isAuthenticated = $derived((getToken() ?? "").length > 0);

export function getIsAuthenticated(): boolean {
  return isAuthenticated;
}

/**
 * Whether the user has finished onboarding. Returns `false` until the
 * `/api/user/identity` response with `onboardedAt` has loaded, so the
 * onboarding gate stays mounted during the initial hydration window
 * instead of flashing the app shell.
 *
 * Returns `true` during an account switch to suppress the gate while
 * the new user's identity loads.
 */
export function getIsOnboarded(): boolean {
  if (isSwitching) return true;
  return Boolean(user?.onboardedAt);
}

export function getIsSwitching(): boolean {
  return isSwitching;
}

export function getAuthRestoreError(): string | null {
  return authRestoreError;
}

export function getAuthRestoreExhausted(): boolean {
  return authRestoreExhausted;
}

export function getAuthRestoreRetryAttempts(): number {
  return loadUserRetryAttempts;
}

export function getAuthRestoreMaxRetries(): number {
  return LOAD_USER_MAX_RETRIES;
}

export function getError(): string | null {
  return error;
}

export function getSignInErrorCode(): SignInErrorCode | null {
  return signInErrorCode;
}

export function getDeviceFlow(): typeof deviceFlow {
  return deviceFlow;
}

/**
 * Forget the signed-in identity and its token. Called by the session
 * lifecycle; stores holding account data are reset there, not here.
 */
export function clearIdentity(): void {
  resetLoadUserRetryState();
  clearToken();
  user = null;
  localAccounts = [];
  identityAttempted = false;
  // The re-auth modal is gated solely on `reauthRequired`, so an invalidated /
  // signed-out session must clear it (and any stale sign-in error) — otherwise
  // a dead session strands the modal with no account behind it.
  reauthRequired = null;
  error = null;
  signInErrorCode = null;
}

function parseSignInErrorCode(value: unknown): SignInErrorCode | null {
  return value === "missing_github_client_id" || value === "invalid_github_client_id"
    ? value
    : null;
}

async function signInHttpError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: string; code?: unknown };
    if (parsed?.error) detail = parsed.error;
    signInErrorCode = parseSignInErrorCode(parsed?.code);
  } catch {
    // Plain-text body — use it as-is.
  }
  return new Error(`Sign-in request failed (${res.status})${detail ? `: ${detail}` : ""}`);
}

function signInErrorMessage(e: unknown): string {
  if (e instanceof TypeError) {
    return `Failed to reach the local Revv server at ${API_BASE_URL}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function authErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

function authErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  const message = (error as { message: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

function shouldClearTokenAfterSessionMiss(error: unknown): boolean {
  if (error === null) return true;
  const status = authErrorStatus(error);
  return status === 401 || status === 403;
}

function clearLoadUserRetryTimer(): void {
  if (!loadUserRetryTimer) return;
  clearTimeout(loadUserRetryTimer);
  loadUserRetryTimer = null;
}

function resetLoadUserRetryState(): void {
  clearLoadUserRetryTimer();
  loadUserRetryAttempts = 0;
  authRestoreError = null;
  authRestoreExhausted = false;
}

function scheduleLoadUserRetry(tokenSnapshot: string, message: string): void {
  authRestoreError = message;
  if (loadUserRetryAttempts >= LOAD_USER_MAX_RETRIES) {
    authRestoreExhausted = true;
    return;
  }
  if (loadUserRetryTimer) return;
  loadUserRetryAttempts += 1;
  loadUserRetryTimer = setTimeout(() => {
    loadUserRetryTimer = null;
    if (getToken() === tokenSnapshot && !user) {
      void loadUser();
    }
  }, LOAD_USER_RETRY_DELAY_MS);
}

export function retryAuthRestore(): void {
  resetLoadUserRetryState();
  void loadUser();
}

export async function signIn(host?: string, clientId?: string): Promise<boolean> {
  error = null;
  signInErrorCode = null;
  isLoading = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/device/init`, {
      method: "POST",
      ...(host
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ host, ...(clientId ? { client_id: clientId } : {}) }),
          }
        : {}),
    });
    if (!res.ok) throw await signInHttpError(res);
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
      ...(host ? { host } : {}),
      ...(clientId ? { clientId } : {}),
    };
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(data.verification_uri);
    } catch {
      // Opening browser is best-effort
    }
    schedulePoll(deviceFlow.interval);
    return true;
  } catch (e) {
    error = `Failed to start sign-in: ${signInErrorMessage(e)}`;
    return false;
  } finally {
    isLoading = false;
  }
}

function schedulePoll(intervalSeconds: number): void {
  pollTimer = setTimeout(() => poll(), intervalSeconds * 1000);
}

async function poll(): Promise<void> {
  if (!deviceFlow) return;

  if (Date.now() > deviceFlow.expiresAt) {
    error = "Sign-in timed out. Please try again.";
    signInErrorCode = null;
    cancelSignIn();
    return;
  }

  try {
    const body: Record<string, string> = { device_code: deviceFlow.deviceCode };
    const token = getToken();
    if (token) body.session_token = token;
    if (deviceFlow.host) body.host = deviceFlow.host;
    if (deviceFlow.clientId) body.client_id = deviceFlow.clientId;
    const res = await fetch(`${API_BASE_URL}/api/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      status?: string;
      token?: string;
      error?: string;
      interval?: number;
    };

    if (data.status === "pending") {
      schedulePoll(deviceFlow.interval);
      return;
    }

    if (data.status === "slow_down") {
      const newInterval = data.interval ?? deviceFlow.interval + 5;
      deviceFlow = { ...deviceFlow, interval: newInterval };
      schedulePoll(newInterval);
      return;
    }

    if (data.status === "linked") {
      deviceFlow = null;
      // Re-auth of the active account lands here (session_token was sent).
      // Clear the gate immediately; the server also broadcasts
      // `auth:reauth-cleared`, but clearing here avoids modal flicker.
      reauthRequired = null;
      await surfaceWindow();
      return;
    }

    if (data.status === "success" && data.token) {
      resetLoadUserRetryState();
      setToken(data.token);
      deviceFlow = null;
      reauthRequired = null;
      await loadUser();
      await surfaceWindow();
      return;
    }

    // Surface the server-provided reason when it's anything other than the two
    // well-known device-flow outcomes (no email on account, GitHub API 4xx, DB
    // error, ...).
    error =
      data.error === "expired"
        ? "Sign-in timed out. Please try again."
        : data.error === "access_denied"
          ? "Sign-in was cancelled."
          : data.error
            ? `Sign-in failed: ${data.error}`
            : "Sign-in failed. Please try again.";
    signInErrorCode = null;
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
}

export function clearError(): void {
  error = null;
  signInErrorCode = null;
}

export async function loadUser(): Promise<void> {
  const tokenSnapshot = getToken();
  if (!tokenSnapshot) return;
  isLoading = true;
  try {
    const session = await authClient.getSession();
    if (session.data?.user) {
      resetLoadUserRetryState();
      const u = session.data.user;
      user = {
        id: u.id,
        name: u.name,
        email: u.email,
        ...(u.image != null ? { image: u.image } : {}),
      };
      // The server refreshes `user.image` on each poll cycle, so the identity
      // read carries a fresh avatar even after GitHub's signed URL expired.
      try {
        const res = await fetch(`${API_BASE_URL}/api/user/identity`, {
          headers: { Authorization: `Bearer ${getToken() ?? tokenSnapshot}` },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            login: string | null;
            avatarContent?: string | null;
            onboardedAt?: string | null;
            reauthRequired?: boolean;
            host?: string | null;
          };
          if (user) {
            const next: User = {
              ...user,
              githubLogin: data.login,
              onboardedAt: data.onboardedAt ?? null,
            };
            if (data.avatarContent != null) {
              next.image = data.avatarContent;
            }
            user = next;
          }
          reauthRequired = data.reauthRequired
            ? { host: data.host ?? null, githubLogin: data.login }
            : null;
        }
      } catch {
        // best-effort
      } finally {
        identityAttempted = true;
      }
      void fetchLocalAccounts();
    } else if (shouldClearTokenAfterSessionMiss(session.error)) {
      clearIdentity();
    } else {
      const message =
        authErrorMessage(session.error) ??
        "Could not restore your session. Revv will retry when the local server is available.";
      error = message;
      scheduleLoadUserRetry(tokenSnapshot, message);
    }
  } catch (e) {
    // A freshly-updated desktop app can open while the restarted local API is
    // still booting. Treat that as a transient startup failure, not logout:
    // clearing the persisted token here makes OnboardingGate believe this is a
    // first-run install until the user closes and reopens the window.
    const message = signInErrorMessage(e);
    error = message;
    scheduleLoadUserRetry(tokenSnapshot, message);
  } finally {
    isLoading = false;
  }
}

export function onUserUpdated(data: UserUpdatedEnvelope["data"]): void {
  if (!user) return;
  const next: User = {
    id: user.id,
    name: data.name,
    email: data.email,
    githubLogin: data.githubLogin,
    onboardedAt: user.onboardedAt ?? null,
  };
  if (data.image != null) {
    next.image = data.image;
  }
  user = next;
}

/**
 * Mark the user as onboarded. Called by `StepDone` once the first repo has
 * been added; flips `onboardedAt` to the server-supplied timestamp so the
 * gate stops rendering the onboarding flow on next render.
 *
 * Failures are silent: the in-memory `user.onboardedAt` is set optimistically
 * so the UI advances; the next identity refresh will reconcile if the POST
 * actually failed.
 */
export async function completeOnboarding(): Promise<void> {
  const token = getToken();
  if (!token || !user) return;
  const localStamp = new Date().toISOString();
  user = { ...user, onboardedAt: localStamp };
  try {
    const res = await fetch(`${API_BASE_URL}/api/onboarding/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { onboardedAt: string };
      if (user) user = { ...user, onboardedAt: data.onboardedAt };
    }
  } catch {
    // best-effort — optimistic local stamp keeps the UI moving
  }
}

/**
 * A replay started from settings: the flow starts from welcome instead of
 * resuming on the step the account's state points at. Lives until the flow
 * reaches its last step.
 */
const ONBOARDING_REPLAY_KEY = "revv-onboarding-replay";

export function isOnboardingReplay(): boolean {
  return (
    typeof sessionStorage !== "undefined" && sessionStorage.getItem(ONBOARDING_REPLAY_KEY) === "1"
  );
}

export function endOnboardingReplay(): void {
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(ONBOARDING_REPLAY_KEY);
}

/**
 * Reset the user's onboarded flag so the OnboardingGate re-shows the flow,
 * as a replay. Auth and tracked repos are kept — this is a "replay"
 * affordance for the settings page, not a destructive reset.
 */
export async function resetOnboarding(): Promise<void> {
  const token = getToken();
  if (!token || !user) return;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(ONBOARDING_REPLAY_KEY, "1");
  }
  user = { ...user, onboardedAt: null };
  try {
    await fetch(`${API_BASE_URL}/api/onboarding/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort — local mirror already flipped; the gate is showing.
  }
}

/** The machine's signed-in users, for the account switcher. Needs a session. */
export async function fetchLocalAccounts(): Promise<void> {
  if (!getToken()) {
    localAccounts = [];
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/local-accounts`, { headers: bearer() });
    if (res.ok) {
      localAccounts = (await res.json()) as LocalAccount[];
    }
  } catch {
    // best-effort
  }
}

/**
 * Run an account switch with the identity marked as switching, so the
 * onboarding gate holds while the new user's identity loads. A failure is
 * recorded as the sign-in error; resolves `true` when `run` succeeded.
 */
export async function runAccountSwitch(run: () => Promise<void>): Promise<boolean> {
  resetLoadUserRetryState();
  isSwitching = true;
  isLoading = true;
  try {
    await run();
    return true;
  } catch (e) {
    error = `Failed to switch account: ${e instanceof Error ? e.message : String(e)}`;
    return false;
  } finally {
    isLoading = false;
    isSwitching = false;
  }
}

/** Ask the server for a session token for another local user. */
export async function requestAccountSwitch(userId: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/auth/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer() },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error("Switch failed");
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Delete the signed-in user on the server. Throws when the server refuses. */
export async function deleteAccount(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/user/account`, {
    method: "DELETE",
    headers: bearer(),
  });
  if (!res.ok) {
    throw new Error(`Failed to remove account: ${res.status}`);
  }
}

function bearer(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getUser(): User | null {
  return user;
}

/** Current user's GitHub login, or null if not yet loaded or missing. */
export function getCurrentUserLogin(): string | null {
  return user?.githubLogin ?? null;
}

/**
 * Whether the GitHub identity fetch has run for this session (successfully or
 * not). Callers that *branch* on `getCurrentUserLogin()` — rather than merely
 * displaying it — should wait for this, otherwise they act on a provisional
 * `null` and have to redo the work when the real answer lands.
 */
export function hasAttemptedIdentityLoad(): boolean {
  return identityAttempted;
}

/**
 * Whether the current user's GitHub login is on the maintainer allowlist.
 * Maintainers bypass the 48h stable-channel cooldown in the in-app updater.
 * Computed locally from `MAINTAINER_LOGINS` so client and server agree without
 * a round-trip — the `/api/user/identity` response also carries this flag,
 * but recomputing here keeps the answer correct even before the first fetch
 * completes (returns `false` until `githubLogin` is loaded).
 */
export function getIsMaintainer(): boolean {
  return isMaintainerLogin(user?.githubLogin ?? null);
}

export function getIsLoading(): boolean {
  return isLoading;
}
