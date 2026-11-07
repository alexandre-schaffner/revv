// Identity of the signed-in user, the device-flow sign-in, and the list of
// accounts on this machine. The session lifecycle that acts on them (start,
// switch, end) lives in `$lib/session/lifecycle.svelte`; this store imports
// no other store.

import { isMaintainerLogin, type UserUpdatedEnvelope } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import { ApiError, call } from "$lib/api/errors";
import { type EdenData, thrownMessage } from "$lib/api/wire";
import { authClient } from "$lib/auth-client";
import { getHeldSessions, holdSession, releaseSession } from "$lib/session/held-sessions";
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
/** A local user and its GitHub account on each host. */
export type LocalAccount = EdenData<(typeof api.api.auth)["local-accounts"]["get"]>[number];

let localAccounts = $state<readonly LocalAccount[]>([]);
/** Whether a signed-out window has finished checking the sessions it holds. */
let localAccountsLoaded = $state(false);
let localAccountsRead = 0;
/**
 * The signed-out window skips the account picker: the user asked to sign in
 * with another account, changed host mid-onboarding, or removed the account
 * the window was on. Lasts until the next sign-in.
 */
let accountPickerDismissed = $state(false);
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

/**
 * The accounts this window can switch to: every local user with a live
 * session when signed in, else the ones whose session this machine holds.
 */
export function getLocalAccounts(): readonly LocalAccount[] {
  return localAccounts;
}

export function getLocalAccountsLoaded(): boolean {
  return localAccountsLoaded;
}

export function getAccountPickerDismissed(): boolean {
  return accountPickerDismissed;
}

export function dismissAccountPicker(): void {
  accountPickerDismissed = true;
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
 * Forget the signed-in identity and its token, then list the held sessions a
 * signed-out window offers. Called by the session lifecycle; stores holding
 * account data are reset there, not here.
 */
export function clearIdentity(): void {
  resetLoadUserRetryState();
  clearToken();
  user = null;
  localAccounts = [];
  localAccountsLoaded = false;
  identityAttempted = false;
  // The re-auth modal is gated solely on `reauthRequired`, so an invalidated /
  // signed-out session must clear it (and any stale sign-in error) — otherwise
  // a dead session strands the modal with no account behind it.
  reauthRequired = null;
  error = null;
  signInErrorCode = null;
  void fetchLocalAccounts();
}

function parseSignInErrorCode(value: unknown): SignInErrorCode | null {
  return value === "missing_github_client_id" || value === "invalid_github_client_id"
    ? value
    : null;
}

function signInRefusal(refusal: ApiError): Error {
  signInErrorCode = parseSignInErrorCode(refusal.body?.code);
  const detail = refusal.serverMessage ?? "";
  return new Error(`Sign-in request failed (${refusal.status})${detail ? `: ${detail}` : ""}`);
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
    const data = await call(
      api.api.auth.device.init.post(
        host ? { host, ...(clientId ? { client_id: clientId } : {}) } : undefined,
      ),
      "Sign-in request failed",
    ).catch((e: unknown) => {
      throw e instanceof ApiError ? signInRefusal(e) : e;
    });
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
    const token = getToken();
    const body = {
      device_code: deviceFlow.deviceCode,
      ...(token ? { session_token: token } : {}),
      ...(deviceFlow.host ? { host: deviceFlow.host } : {}),
      ...(deviceFlow.clientId ? { client_id: deviceFlow.clientId } : {}),
    };
    let data: EdenData<typeof api.api.auth.device.poll.post> | null = null;
    let reason: string | undefined;
    try {
      data = await call(api.api.auth.device.poll.post(body), "Sign-in failed");
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      reason = e.serverMessage;
    }
    if (data?.status === "pending") {
      schedulePoll(deviceFlow.interval);
      return;
    }

    if (data?.status === "slow_down") {
      const newInterval = data.interval ?? deviceFlow.interval + 5;
      deviceFlow = { ...deviceFlow, interval: newInterval };
      schedulePoll(newInterval);
      return;
    }

    if (data?.status === "linked") {
      deviceFlow = null;
      // Re-auth of the active account lands here (session_token was sent).
      // Clear the gate immediately; the server also broadcasts
      // `auth:reauth-cleared`, but clearing here avoids modal flicker.
      reauthRequired = null;
      await surfaceWindow();
      return;
    }

    if (data?.status === "success") {
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
      reason === "expired"
        ? "Sign-in timed out. Please try again."
        : reason === "access_denied"
          ? "Sign-in was cancelled."
          : reason
            ? `Sign-in failed: ${reason}`
            : "Sign-in failed. Please try again.";
    signInErrorCode = null;
    cancelSignIn();
  } catch {
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
      await readIdentity();
      identityAttempted = true;
      accountPickerDismissed = false;
      holdCurrentSession();
      void fetchLocalAccounts();
    } else if (shouldClearTokenAfterSessionMiss(session.error)) {
      releaseSession({ token: tokenSnapshot });
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

/**
 * Mirror the server's identity: login, onboarding, avatar and whether the
 * account needs re-auth. The server refreshes `user.image` on each poll cycle,
 * so this carries a fresh avatar even after GitHub's signed URL expired.
 * Best-effort: a failed read keeps what's shown.
 */
async function readIdentity(): Promise<void> {
  try {
    const data = await call(api.api.user.identity.get(), "Identity read failed");
    if (user) {
      const next: User = {
        ...user,
        githubLogin: data.login,
        onboardedAt: data.onboardedAt ?? null,
      };
      if (data.avatarContent != null) next.image = data.avatarContent;
      user = next;
    }
    reauthRequired = data.reauthRequired
      ? { host: data.host ?? null, githubLogin: data.login }
      : null;
  } catch {}
}

/** `auth:reauth-*` and `user:updated` sent while the stream was down reached no one. */
export function onEventsReconnected(): void {
  if (user) void readIdentity();
}

/** Keep the signed-in session, so a signed-out window can offer it again. */
function holdCurrentSession(): void {
  const token = getToken();
  if (!user || !token) return;
  holdSession({
    userId: user.id,
    token,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
  });
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
  holdCurrentSession();
}

/**
 * Optimistic and silent on failure: the UI advances at once, and the next
 * identity read reconciles if the POST didn't land.
 */
export async function completeOnboarding(): Promise<void> {
  if (!getToken() || !user) return;
  const localStamp = new Date().toISOString();
  user = { ...user, onboardedAt: localStamp };
  try {
    const data = await call(api.api.onboarding.complete.post(), "Onboarding failed");
    if (user) user = { ...user, onboardedAt: data.onboardedAt };
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
  if (!getToken() || !user) return;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(ONBOARDING_REPLAY_KEY, "1");
  }
  user = { ...user, onboardedAt: null };
  try {
    await call(api.api.onboarding.reset.post(), "Onboarding reset failed");
  } catch {
    // best-effort — local mirror already flipped; the gate is showing.
  }
}

/**
 * Read the accounts this window can switch to. Signed in, the server lists
 * them; signed out, each held session is asked for its own accounts with its
 * own token, and one the server no longer honours is forgotten.
 */
export async function fetchLocalAccounts(): Promise<void> {
  const read = ++localAccountsRead;
  const next = getToken() ? await signedInLocalAccounts() : await heldLocalAccounts();
  if (read !== localAccountsRead || next === null) return;
  localAccounts = next;
  localAccountsLoaded = true;
}

async function signedInLocalAccounts(): Promise<readonly LocalAccount[] | null> {
  try {
    return await call(api.api.auth["local-accounts"].get(), "Accounts read failed");
  } catch {
    return null;
  }
}

async function heldLocalAccounts(): Promise<readonly LocalAccount[]> {
  const rows = await Promise.all(
    getHeldSessions().map(async (held): Promise<LocalAccount | null> => {
      try {
        const data = await call(
          api.api.auth.accounts.get({ headers: { Authorization: `Bearer ${held.token}` } }),
          "Accounts read failed",
        );
        const accounts = data
          .filter((a) => a.connected)
          .map(({ host, githubLogin, avatarUrl }) => ({ host, githubLogin, avatarUrl }));
        return accounts.length > 0
          ? { id: held.userId, name: held.name, email: held.email, image: held.image, accounts }
          : null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) releaseSession({ token: held.token });
        return null;
      }
    }),
  );
  return rows.filter((row) => row !== null);
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
    error = `Failed to switch account: ${thrownMessage(e)}`;
    return false;
  } finally {
    isLoading = false;
    isSwitching = false;
  }
}

/** Ask the server for a session token for another local user. */
export async function requestAccountSwitch(userId: string): Promise<string> {
  const { token } = await call(api.api.auth.switch.post({ userId }), "Switch failed");
  return token;
}

export async function deleteAccount(): Promise<void> {
  await call(api.api.user.account.delete(), "Failed to remove account");
}

export function getUser(): User | null {
  return user;
}

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
 * Maintainers bypass the 48h stable-channel cooldown in the in-app updater.
 * Computed locally from `MAINTAINER_LOGINS` rather than read from
 * `/api/user/identity`, so client and server agree without a round-trip
 * (false until `githubLogin` loads).
 */
export function getIsMaintainer(): boolean {
  return isMaintainerLogin(user?.githubLogin ?? null);
}

export function getIsLoading(): boolean {
  return isLoading;
}
