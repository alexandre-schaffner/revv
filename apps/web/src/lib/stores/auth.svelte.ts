// Identity of the signed-in user, their GitHub account on each host, the
// device-flow sign-in, and the list of local users on this machine. The session lifecycle that acts on them (start,
// switch, end) lives in `$lib/session/lifecycle.svelte`; this store imports
// no other store.

import {
  type ApiErrorCode,
  type AuthReauthClearedEnvelope,
  type AuthReauthRequiredEnvelope,
  isMaintainerLogin,
  sameGithubHost,
  type UserIdentity,
  type UserUpdatedEnvelope,
} from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import { ApiError, apiErrorCode, call } from "$lib/api/errors";
import { type EdenData, thrownMessage } from "$lib/api/wire";
import {
  type Account,
  accountOn,
  reauthAsked,
  withIdentity,
  withReauth,
} from "$lib/session/accounts";
import { getHeldSessions, holdSession, releaseSession } from "$lib/session/held-sessions";
import { clearToken, getToken, setToken } from "$lib/session/token.svelte";
import { surfaceWindow } from "$lib/utils/surface-window";

const LOAD_USER_RETRY_DELAY_MS = 1000;
const LOAD_USER_MAX_RETRIES = 10;

/** The signed-in user, shown as their account on the active host. */
interface User extends UserIdentity {
  githubLogin: string | null;
  /** The cached avatar bytes as a data URL: GitHub Enterprise's signed avatar URLs expire. */
  image?: string;
}

let identity = $state<UserIdentity | null>(null);
/**
 * The user's accounts. Read with the identity, reconciled on every reconnect
 * (`/api/auth/accounts` probes each flagged one), and updated live by
 * `user:updated` and `auth:reauth-*` for their host.
 */
let accounts = $state<readonly Account[]>([]);

const user = $derived.by((): User | null => {
  if (!identity) return null;
  const shown = identity.host ? accountOn(accounts, identity.host) : undefined;
  return {
    ...identity,
    githubLogin: shown?.githubLogin ?? null,
    ...(shown?.avatarContent ? { image: shown.avatarContent } : {}),
  };
});
let isLoading = $state(false);
let isSwitching = $state(false);
let error = $state<string | null>(null);

/** A sign-in refused for its client id: the host needs one, or the one it has isn't valid. */
export type SignInErrorCode = Extract<
  ApiErrorCode,
  "MISSING_GITHUB_CLIENT_ID" | "INVALID_GITHUB_CLIENT_ID"
>;
let signInErrorCode = $state<SignInErrorCode | null>(null);

let deviceFlow = $state<{
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
  /** The host and client `/device/init` resolved; the poll must use the same ones. */
  host: string;
  clientId: string;
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

let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** The first account that must sign in again: what the blocking re-sign-in modal asks for. */
export function getReauthRequired(): Account | null {
  return reauthAsked(accounts);
}

export function onAuthReauthRequired(data: AuthReauthRequiredEnvelope["data"]): void {
  accounts = withReauth(accounts, { ...data, reauthRequired: true });
}

export function onAuthReauthCleared(data: AuthReauthClearedEnvelope["data"]): void {
  accounts = withReauth(accounts, { host: data.host, reauthRequired: false });
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
  return Boolean(identity?.onboardedAt);
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
  identity = null;
  // The re-auth modal reads the accounts, so a dead session must not strand
  // it with no session behind it.
  accounts = [];
  localAccounts = [];
  localAccountsLoaded = false;
  error = null;
  signInErrorCode = null;
  void fetchLocalAccounts();
}

function signInRefusal(refusal: ApiError): Error {
  const code = apiErrorCode(refusal);
  signInErrorCode =
    code === "MISSING_GITHUB_CLIENT_ID" || code === "INVALID_GITHUB_CLIENT_ID" ? code : null;
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

/** The server no longer accepts this session's token: signing out beats retrying. */
function isSessionMiss(e: unknown): boolean {
  const code = apiErrorCode(e);
  return code === "UNAUTHORIZED" || code === "GITHUB_AUTH_ERROR" || code === "FORBIDDEN";
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
    if (getToken() === tokenSnapshot && !identity) {
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
      host: data.host,
      clientId: data.client_id,
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
    endSignIn("Sign-in timed out. Please try again.");
    return;
  }

  try {
    const token = getToken();
    const body = {
      device_code: deviceFlow.deviceCode,
      ...(token ? { session_token: token } : {}),
      host: deviceFlow.host,
      client_id: deviceFlow.clientId,
    };
    let data: EdenData<typeof api.api.auth.device.poll.post>;
    try {
      data = await call(api.api.auth.device.poll.post(body), "Sign-in failed");
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      endSignIn(
        e.serverMessage
          ? `Sign-in failed: ${e.serverMessage}`
          : "Sign-in failed. Please try again.",
      );
      return;
    }
    switch (data.status) {
      case "pending":
        schedulePoll(deviceFlow.interval);
        return;
      case "slow_down": {
        const newInterval = data.interval ?? deviceFlow.interval + 5;
        deviceFlow = { ...deviceFlow, interval: newInterval };
        schedulePoll(newInterval);
        return;
      }
      case "expired":
        endSignIn("Sign-in timed out. Please try again.");
        return;
      case "denied":
        endSignIn("Sign-in was cancelled.");
        return;
      case "linked":
        // A re-auth or a link of the account on `host`; the server also
        // broadcasts `auth:reauth-cleared`, but clearing here avoids modal
        // flicker.
        accounts = withReauth(accounts, { host: deviceFlow.host, reauthRequired: false });
        deviceFlow = null;
        await surfaceWindow();
        return;
      case "success":
        resetLoadUserRetryState();
        setToken(data.token);
        deviceFlow = null;
        await loadUser();
        await surfaceWindow();
        return;
    }
  } catch {
    if (deviceFlow) schedulePoll(deviceFlow.interval);
  }
}

function endSignIn(message: string): void {
  error = message;
  signInErrorCode = null;
  cancelSignIn();
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
    const read = await readSession(
      "Could not restore your session. Revv will retry when the local server is available.",
    );
    resetLoadUserRetryState();
    applySession(read);
    accountPickerDismissed = false;
    holdCurrentSession();
    void fetchLocalAccounts();
  } catch (e) {
    if (isSessionMiss(e)) {
      releaseSession({ token: tokenSnapshot });
      clearIdentity();
      return;
    }
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

/** The identity and the accounts, read together: the shown login is the identity host's account's. */
async function readSession(
  fallback: string,
): Promise<{ identity: UserIdentity; accounts: readonly Account[] }> {
  const [identity, rows] = await Promise.all([
    call(api.api.user.identity.get(), fallback),
    call(api.api.auth.accounts.get(), fallback),
  ]);
  const read = rows
    .filter((a) => a.connected)
    .map(({ host, githubLogin, avatarContent, reauthRequired }) => ({
      host,
      githubLogin,
      avatarContent,
      reauthRequired,
    }));
  return { identity, accounts: read };
}

function applySession(read: { identity: UserIdentity; accounts: readonly Account[] }): void {
  accounts = read.accounts;
  identity = read.identity;
}

/** Re-read what a missed push would have changed. A failed read keeps what's shown. */
async function reconcileSession(): Promise<void> {
  const shown = identity?.id;
  try {
    const read = await readSession("Identity read failed");
    if (shown !== undefined && identity?.id === shown) applySession(read);
  } catch {}
  void fetchLocalAccounts();
}

/** `auth:reauth-*` and `user:updated` sent while the stream was down reached no one. */
export function onEventsReconnected(): void {
  if (identity) void reconcileSession();
}

/** Keep the signed-in session, so a signed-out window can offer it again. */
function holdCurrentSession(): void {
  const token = getToken();
  if (!user || !token) return;
  holdSession({ userId: user.id, token, name: user.name, email: user.email });
}

export function onUserUpdated(data: UserUpdatedEnvelope["data"]): void {
  if (identity?.id !== data.id) return;
  // The account switchers show every account's login and avatar.
  void fetchLocalAccounts();
  identity = { ...identity, name: data.name, email: data.email };
  accounts = withIdentity(accounts, data);
  holdCurrentSession();
}

/**
 * Optimistic and silent on failure: the UI advances at once, and the next
 * identity read reconciles if the POST didn't land.
 */
export async function completeOnboarding(): Promise<void> {
  if (!getToken() || !identity) return;
  const localStamp = new Date().toISOString();
  identity = { ...identity, onboardedAt: localStamp };
  try {
    const data = await call(api.api.onboarding.complete.post(), "Onboarding failed");
    if (identity) identity = { ...identity, onboardedAt: data.onboardedAt };
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
  if (!getToken() || !identity) return;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(ONBOARDING_REPLAY_KEY, "1");
  }
  identity = { ...identity, onboardedAt: null };
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
          .map(({ host, githubLogin, avatarContent }) => ({ host, githubLogin, avatarContent }));
        return accounts.length > 0
          ? { id: held.userId, name: held.name, email: held.email, accounts }
          : null;
      } catch (e) {
        if (apiErrorCode(e) === "UNAUTHORIZED") releaseSession({ token: held.token });
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

/**
 * Whether a push about the account on `host` is about the lists on screen:
 * those of the active host's account. The stream carries every account.
 */
export function isShownHost(host: string): boolean {
  return user?.host == null || sameGithubHost(user.host, host);
}

/** Who "me" is on the active host: the login of the user's account there. */
export function getCurrentUserLogin(): string | null {
  return user?.githubLogin ?? null;
}

/**
 * Who "me" is on `host`'s repositories: the login of the user's account
 * there. Without a host, the active host's.
 */
export function loginOnHost(host: string | null): string | null {
  return host === null ? getCurrentUserLogin() : (accountOn(accounts, host)?.githubLogin ?? null);
}

/**
 * Whether the identity has loaded for this session: the user and their login
 * arrive together. Callers that *branch* on `getCurrentUserLogin()` — rather
 * than merely displaying it — should wait for this, otherwise they act on a
 * provisional `null` and have to redo the work when the real answer lands.
 */
export function isIdentityLoaded(): boolean {
  return identity !== null;
}

/**
 * Maintainers bypass the 48h stable-channel cooldown in the in-app updater.
 * Computed locally from `MAINTAINER_LOGINS` rather than read from
 * `/api/user/identity`, so client and server agree without a round-trip
 * (false until `githubLogin` loads).
 */
export function getIsMaintainer(): boolean {
  return isMaintainerLogin(getCurrentUserLogin());
}

export function getIsLoading(): boolean {
  return isLoading;
}
