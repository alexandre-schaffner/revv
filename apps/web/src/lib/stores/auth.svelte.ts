// Identity of the signed-in user, their GitHub account on each host, the
// device-flow sign-in, and the list of local users on this machine. The session lifecycle that acts on them (start,
// switch, end) lives in `$lib/session/lifecycle.svelte`; this store imports
// no other store.

import {
  type ApiErrorCode,
  type AuthReauthClearedEnvelope,
  type AuthReauthRequiredEnvelope,
  isMaintainerLogin,
  normalizeGithubHost,
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
  reauthsCleared,
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

/**
 * Replace the accounts. A re-auth that no longer applies ends its sign-in: the
 * modal it showed in is gone, and a waiting one doesn't come back unasked.
 */
function setAccounts(next: readonly Account[]): void {
  for (const host of reauthsCleared(accounts, next)) {
    cancelSignIn(host);
    if (reauthOpenedFor !== null && sameGithubHost(reauthOpenedFor, host)) reauthOpenedFor = null;
  }
  accounts = next;
}

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

/** The host `error` is about, when it is a sign-in's on a known host. */
let errorHost = $state<string | null>(null);

/** A sign-in refused for its client id: the host needs one, or the one it has isn't valid. */
export type SignInErrorCode = Extract<
  ApiErrorCode,
  "MISSING_GITHUB_CLIENT_ID" | "INVALID_GITHUB_CLIENT_ID"
>;
let signInErrorCode = $state<SignInErrorCode | null>(null);

interface DeviceFlow {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly deviceCode: string;
  readonly interval: number;
  readonly expiresAt: number;
  /** The host and client `/device/init` resolved; the poll must use the same ones. */
  readonly host: string;
  readonly clientId: string;
}

/**
 * The device-flow sign-ins under way, one per host: a waiting account's
 * re-sign-in and the shown host's can run at once, each showing its own code.
 */
let deviceFlows = $state<ReadonlyMap<string, DeviceFlow>>(new Map());
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

const reauths = $derived(reauthAsked(accounts, identity?.host ?? null));
/** The host of a waiting account the user chose to sign in again from the account menu. */
let reauthOpenedFor = $state<string | null>(null);

/**
 * The account the re-sign-in modal asks for: the shown host's, which blocks
 * the window, else a waiting one the user opened, which they can dismiss.
 */
export function getReauthPrompt(): {
  readonly account: Account;
  readonly blocking: boolean;
} | null {
  if (reauths.blocking) return { account: reauths.blocking, blocking: true };
  const host = reauthOpenedFor;
  const opened = host === null ? undefined : accountOn(reauths.waiting, host);
  return opened ? { account: opened, blocking: false } : null;
}

/** Accounts on hosts this window doesn't show that must sign in again: they wait in the account menu. */
export function getWaitingReauths(): readonly Account[] {
  return reauths.waiting;
}

/** Sign a waiting account in again, in the dismissible re-sign-in modal. */
export function openReauth(host: string): void {
  reauthOpenedFor = host;
  void signIn(host);
}

export function closeReauth(): void {
  const host = reauthOpenedFor;
  reauthOpenedFor = null;
  clearError();
  if (host !== null) cancelSignIn(host);
}

export function onAuthReauthRequired(data: AuthReauthRequiredEnvelope["data"]): void {
  setAccounts(withReauth(accounts, { ...data, reauthRequired: true }));
}

export function onAuthReauthCleared(data: AuthReauthClearedEnvelope["data"]): void {
  setAccounts(withReauth(accounts, { host: data.host, reauthRequired: false }));
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

/** The error to show a sign-in on `host`: one about another host's sign-in isn't. */
export function getErrorFor(host: string): string | null {
  return errorHost === null || sameGithubHost(errorHost, host) ? error : null;
}

export function getSignInErrorCode(host: string): SignInErrorCode | null {
  return errorHost !== null && sameGithubHost(errorHost, host) ? signInErrorCode : null;
}

/** The sign-in under way on `host`; without one, any (a signed-out window runs one at most). */
export function getDeviceFlow(host?: string): DeviceFlow | null {
  if (host !== undefined) return deviceFlows.get(normalizeGithubHost(host)) ?? null;
  return deviceFlows.values().next().value ?? null;
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
  setAccounts([]);
  reauthOpenedFor = null;
  localAccounts = [];
  localAccountsLoaded = false;
  clearError();
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
  clearError();
  isLoading = true;
  try {
    // A signed-in caller sends its session, so re-signing one of its accounts
    // in uses the client that account was issued to.
    const token = getToken();
    const body = {
      ...(host ? { host } : {}),
      ...(host && clientId ? { client_id: clientId } : {}),
      ...(token ? { session_token: token } : {}),
    };
    const data = await call(api.api.auth.device.init.post(body), "Sign-in request failed").catch(
      (e: unknown) => {
        throw e instanceof ApiError ? signInRefusal(e) : e;
      },
    );
    const flow: DeviceFlow = {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      deviceCode: data.device_code,
      interval: data.interval ?? 5,
      expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
      host: data.host,
      clientId: data.client_id,
    };
    cancelSignIn(flow.host);
    setFlow(flow);
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(data.verification_uri);
    } catch {
      // Opening browser is best-effort
    }
    schedulePoll(flow);
    return true;
  } catch (e) {
    setError(`Failed to start sign-in: ${signInErrorMessage(e)}`, host ?? null);
    return false;
  } finally {
    isLoading = false;
  }
}

function setFlow(flow: DeviceFlow): void {
  deviceFlows = new Map(deviceFlows).set(normalizeGithubHost(flow.host), flow);
}

/** Whether `flow` is still its host's sign-in: not cancelled or restarted since. */
function isCurrent(flow: DeviceFlow): boolean {
  return deviceFlows.get(normalizeGithubHost(flow.host)) === flow;
}

function schedulePoll(flow: DeviceFlow): void {
  const key = normalizeGithubHost(flow.host);
  pollTimers.set(
    key,
    setTimeout(() => void poll(flow), flow.interval * 1000),
  );
}

async function poll(flow: DeviceFlow): Promise<void> {
  if (!isCurrent(flow)) return;

  if (Date.now() > flow.expiresAt) {
    endSignIn(flow.host, "Sign-in timed out. Please try again.");
    return;
  }

  try {
    const token = getToken();
    const body = {
      device_code: flow.deviceCode,
      ...(token ? { session_token: token } : {}),
      host: flow.host,
      client_id: flow.clientId,
    };
    let data: EdenData<typeof api.api.auth.device.poll.post>;
    try {
      data = await call(api.api.auth.device.poll.post(body), "Sign-in failed");
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (!isCurrent(flow)) return;
      endSignIn(
        flow.host,
        e.serverMessage
          ? `Sign-in failed: ${e.serverMessage}`
          : "Sign-in failed. Please try again.",
      );
      return;
    }
    // GitHub's grant is final even when this sign-in was cancelled or its
    // re-auth cleared while the answer was on its way.
    if (data.status === "linked") {
      // A re-auth or a link of the account on `host`; the server also
      // broadcasts `auth:reauth-cleared`, but clearing here avoids modal
      // flicker.
      setAccounts(withReauth(accounts, { host: flow.host, reauthRequired: false }));
      if (isCurrent(flow)) cancelSignIn(flow.host);
      await surfaceWindow();
      return;
    }
    if (data.status === "success") {
      resetLoadUserRetryState();
      setToken(data.token);
      if (isCurrent(flow)) cancelSignIn(flow.host);
      await loadUser();
      await surfaceWindow();
      return;
    }
    if (!isCurrent(flow)) return;
    switch (data.status) {
      case "pending":
        schedulePoll(flow);
        return;
      case "slow_down": {
        const slower = { ...flow, interval: data.interval ?? flow.interval + 5 };
        setFlow(slower);
        schedulePoll(slower);
        return;
      }
      case "expired":
        endSignIn(flow.host, "Sign-in timed out. Please try again.");
        return;
      case "denied":
        endSignIn(flow.host, "Sign-in was cancelled.");
        return;
    }
  } catch {
    if (isCurrent(flow)) schedulePoll(flow);
  }
}

function endSignIn(host: string, message: string): void {
  cancelSignIn(host);
  signInErrorCode = null;
  setError(message, host);
}

/** Stop the sign-in on `host`, or every one. */
export function cancelSignIn(host?: string): void {
  const keys = host === undefined ? [...deviceFlows.keys()] : [normalizeGithubHost(host)];
  const next = new Map(deviceFlows);
  for (const key of keys) {
    clearTimeout(pollTimers.get(key));
    pollTimers.delete(key);
    next.delete(key);
  }
  if (next.size !== deviceFlows.size) deviceFlows = next;
}

/** Show `message`; with `host` when it is about the sign-in on that host. */
function setError(message: string, host: string | null = null): void {
  error = message;
  errorHost = host;
}

export function clearError(): void {
  error = null;
  errorHost = null;
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
    setError(message);
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
  setAccounts(read.accounts);
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
  setAccounts(withIdentity(accounts, data));
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
    setError(`Failed to switch account: ${thrownMessage(e)}`);
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
