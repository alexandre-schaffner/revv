import { goto } from "$app/navigation";
import { API_BASE_URL } from "$lib/api/base-url";
import { authClient } from "$lib/auth-client";
import { stopPolling } from "$lib/services/sync";
import {
  connect as connectEvents,
  disconnect as disconnectEvents,
} from "$lib/stores/events.svelte";
import { fetchOrgs, initForUser, reset as resetOrgs } from "$lib/stores/orgs.svelte";
import { fetchPinnedPrs, fetchPrs, fetchRepos, reset as resetPrs } from "$lib/stores/prs.svelte";
import { clearReviewFiles } from "$lib/stores/review.svelte";
import { fetchSettings, reset as resetSettings } from "$lib/stores/settings.svelte";
import { connect as connectWs, disconnect as disconnectWs } from "$lib/stores/ws.svelte";

const storedToken =
  typeof localStorage !== "undefined" ? localStorage.getItem("rev_session_token") : null;

let token = $state<string | null>(storedToken);
let user = $state<{
  name: string;
  email: string;
  image?: string;
  githubLogin?: string | null;
  onboardedAt?: string | null;
} | null>(null);
let isLoading = $state(false);
let isSwitching = $state(false);
let error = $state<string | null>(null);

let deviceFlow = $state<{
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
  host?: string;
} | null>(null);
let isPolling = $state(false);

export type ConnectedAccount = {
  host: string;
  connected: boolean;
  githubLogin: string | null;
  avatarUrl: string | null;
};

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

let connectedAccounts = $state<ConnectedAccount[]>([]);
let localAccounts = $state<LocalAccount[]>([]);
let accountJustRemoved = $state(false);

export function getLocalAccounts(): LocalAccount[] {
  return localAccounts;
}

export function getAccountJustRemoved(): boolean {
  return accountJustRemoved;
}

export function getForceOnboardingFlow(): boolean {
  return forceOnboardingFlow;
}

export function resetForceOnboardingFlow(): void {
  forceOnboardingFlow = false;
}

export function setForceOnboardingFlow(): void {
  forceOnboardingFlow = true;
}
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const isAuthenticated = $derived(token !== null && token.length > 0);
let forceOnboardingFlow = $state(false);

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

export function getError(): string | null {
  return error;
}

export function getDeviceFlow(): typeof deviceFlow {
  return deviceFlow;
}

export function setToken(newToken: string): void {
  token = newToken;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("rev_session_token", newToken);
  }
}

export function clearToken(): void {
  token = null;
  user = null;
  connectedAccounts = [];
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("rev_session_token");
  }
}

export async function signIn(host?: string): Promise<void> {
  error = null;
  isLoading = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/device/init`, {
      method: "POST",
      ...(host
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host }) }
        : {}),
    });
    if (!res.ok) throw new Error("Failed to initiate sign-in");
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
    };
    try {
      const { isTauri } = await import("$lib/utils/platform");
      if (isTauri()) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(data.verification_uri);
      } else {
        window.open(data.verification_uri, "_blank");
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
    error = "Sign-in timed out. Please try again.";
    cancelSignIn();
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        (() => {
          const body: Record<string, string> = { device_code: deviceFlow.deviceCode };
          if (token) body.session_token = token;
          if (deviceFlow.host) body.host = deviceFlow.host;
          return body;
        })(),
      ),
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
      isPolling = false;
      await fetchConnectedAccounts();
      await focusWindow();
      return;
    }

    if (data.status === "success" && data.token) {
      setToken(data.token);
      deviceFlow = null;
      isPolling = false;
      await loadUser();
      await focusWindow();
      // Auto-open-add-repo on sign-in used to live here. The onboarding
      // flow now owns the repo step inline (StepRepo.svelte), so we
      // intentionally don't pop a dialog — OnboardingGate stays mounted
      // and advances to its repo step automatically.
      return;
    }

    // Error cases. Surface the server-provided reason when it's anything
    // other than the two well-known device-flow outcomes — otherwise every
    // real failure (no email on account, GitHub API 4xx, DB error, etc.)
    // gets flattened to the same useless "Sign-in failed" string.
    error =
      data.error === "expired"
        ? "Sign-in timed out. Please try again."
        : data.error === "access_denied"
          ? "Sign-in was cancelled."
          : data.error
            ? `Sign-in failed: ${data.error}`
            : "Sign-in failed. Please try again.";
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

export function clearError(): void {
  error = null;
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
      // Fetch GitHub login + fresh avatar URL. The server refreshes
      // `user.image` on each poll cycle (same pattern as repo avatars) so
      // the signed-URL-expiry issue that used to break user avatars
      // resolves itself without requiring re-auth.
      try {
        const res = await fetch(`${API_BASE_URL}/api/user/identity`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            login: string | null;
            avatarContent?: string | null;
            onboardedAt?: string | null;
          };
          if (user) {
            const next: typeof user = {
              ...user,
              githubLogin: data.login,
              onboardedAt: data.onboardedAt ?? null,
            };
            // Prefer the server's freshly-refreshed avatar content when available.
            if (data.avatarContent != null) {
              next.image = data.avatarContent;
            }
            user = next;
            accountJustRemoved = false;
          }
        }
      } catch {
        // best-effort
      }
      // Init per-user org selection before fetching orgs
      initForUser(u.id);
      // Fire-and-forget org list fetch so the sidebar switcher has
      // data ready when the user opens it. Failures degrade silently.
      void fetchOrgs();
      void fetchConnectedAccounts();
      void fetchLocalAccounts();
    } else {
      clearToken();
    }
  } catch {
    clearToken();
  } finally {
    isLoading = false;
  }
}

/**
 * Apply a server-pushed user update (e.g. avatar URL rotation).
 * Called by the WS handler when the poll scheduler detects that the
 * authenticated user's GitHub profile changed.
 */
export function applyUserUpdate(update: {
  image: string | null;
  githubLogin: string | null;
  name?: string;
  email?: string;
}): void {
  if (!user) return;
  const next: typeof user = {
    name: update.name ?? user.name,
    email: update.email ?? user.email,
    githubLogin: update.githubLogin,
    onboardedAt: user.onboardedAt ?? null,
  };
  if (update.image != null) {
    next.image = update.image;
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
 * Reset the user's onboarded flag so the OnboardingGate re-shows the flow.
 * Auth and tracked repos are kept — this is a "replay" affordance for the
 * settings page, not a destructive reset.
 *
 * Pairs with `sessionStorage['revv-onboarding-replay']`, which the
 * OnboardingFlow reads to bypass its usual "resume on the right step"
 * logic and always start from the welcome step.
 */
export async function resetOnboarding(): Promise<void> {
  if (!token || !user) return;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem("revv-onboarding-replay", "1");
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

export async function fetchConnectedAccounts(): Promise<void> {
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      connectedAccounts = (await res.json()) as ConnectedAccount[];
    }
  } catch {
    // best-effort
  }
}

export async function fetchLocalAccounts(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/local-accounts`);
    if (res.ok) {
      localAccounts = (await res.json()) as LocalAccount[];
    }
  } catch {
    // best-effort
  }
}

// Pre-fetch local accounts on module load so the account picker has data
// before the user has a token (lock-screen scenario).
if (typeof localStorage !== "undefined") {
  void fetchLocalAccounts();
}

export async function switchAccount(userId: string, host?: string): Promise<void> {
  isSwitching = true;
  isLoading = true;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE_URL}/api/auth/switch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error("Switch failed");
    const data = (await res.json()) as { token: string };
    setToken(data.token);
    resetPrs();
    resetSettings();
    resetOrgs();
    clearReviewFiles();
    if (typeof window !== "undefined" && /^\/(repo|review)(\/|$)/.test(window.location.pathname)) {
      await goto("/", { replaceState: true });
    }
    // Persist the target host on the server FIRST so any handler resolving
    // the active account from settings (e.g. `/api/prs`, `/api/repos`) sees
    // the right host immediately. We hit the endpoint directly because the
    // local settings store is null right now (just reset) and the optimistic
    // merge in `updateSettings` would no-op.
    if (host) {
      try {
        await fetch(`${API_BASE_URL}/api/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.token}` },
          body: JSON.stringify({ githubHost: host }),
        });
      } catch {
        // best-effort — the WS host override below is the load-bearing path;
        // the persisted setting only affects post-switch REST handlers and a
        // missed PUT will self-heal once the user updates settings explicitly.
      }
    }
    // Reconnect WebSocket with the new session token AND explicit host so
    // the server binds the WS to the target user's correct account on the
    // first attempt, even though the local settings store is still null.
    // Without the explicit host, the server falls back to
    // `findAccount(userId, undefined)`, picks the wrong (or no) account,
    // and the user never receives `prs:updated` broadcasts.
    disconnectWs();
    disconnectEvents();
    connectWs(data.token, host);
    connectEvents(data.token, host);
    await loadUser();
    // Pull settings into the local store so getGithubHost() returns the
    // new host (e.g. for WS auto-reconnects and OrgSwitcher highlighting)
    // and re-hydrate the PR / repo lists under the switched-to account.
    await fetchSettings();
    await Promise.all([fetchPrs(), fetchRepos(), fetchPinnedPrs()]);
  } catch (e) {
    error = `Failed to switch account: ${e}`;
  } finally {
    isLoading = false;
    isSwitching = false;
  }
}

export async function removeAccount(): Promise<void> {
  if (!token) return;
  stopPolling();
  const res = await fetch(`${API_BASE_URL}/api/user/account`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to remove account: ${res.status}`);
  }
  // Server confirmed deletion — now clean up local state
  accountJustRemoved = true;
  disconnectWs();
  disconnectEvents();
  clearToken();
  resetPrs();
  resetSettings();
  resetOrgs();
  clearReviewFiles();
  await fetchLocalAccounts();
  forceOnboardingFlow = true;
  await goto("/");
}

export async function signOut(): Promise<void> {
  stopPolling();

  // Soft sign-out: tell server (no-op), then clear local state
  try {
    await fetch(`${API_BASE_URL}/api/auth/revoke-and-sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }

  clearToken();
  resetPrs();
  resetSettings();
  resetOrgs();

  await goto("/");
}

export function getToken(): string | null {
  return token;
}

export function getUser(): {
  name: string;
  email: string;
  image?: string;
  githubLogin?: string | null;
  onboardedAt?: string | null;
} | null {
  return user;
}

/** Current user's GitHub login, or null if not yet loaded or missing. */
export function getCurrentUserLogin(): string | null {
  return user?.githubLogin ?? null;
}

export function getIsLoading(): boolean {
  return isLoading;
}

/** Bring the app window to the foreground after auth completes. */
export async function focusWindow(): Promise<void> {
  try {
    const { isTauri } = await import("$lib/utils/platform");
    if (isTauri()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFocus();
    } else {
      window.focus();
    }
  } catch {
    // Focus is best-effort
  }
}
