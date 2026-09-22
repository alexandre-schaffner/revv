import {
  GITHUB_CLIENT_ID_HINT,
  isLikelyGitHubClientId,
  type PullRequest,
  type PullRequestLocator,
  parsePullRequestDeepLink,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { API_BASE_URL } from "$lib/api/base-url";
import {
  cancelSignIn,
  clearError,
  fetchLocalAccounts,
  getDeviceFlow,
  getError,
  getIsAuthenticated,
  getIsOnboarded,
  getLocalAccounts,
  getUser,
  signIn,
  switchAccount,
} from "$lib/stores/auth.svelte";
import {
  fetchDefaultCloneBaseDir,
  fetchRepos,
  getDefaultCloneBaseDir,
  upsertPullRequest,
} from "$lib/stores/prs.svelte";
import {
  getGithubClientId,
  getGithubHost,
  setGithubConfigStrict,
  updateSettings,
} from "$lib/stores/settings.svelte";
import { authHeaders } from "$lib/utils/session-token";

export interface AccountChoice {
  readonly userId: string;
  readonly host: string;
  readonly login: string;
  readonly email: string;
  readonly avatarUrl: string | null;
}

export type PrDeepLinkState =
  | { readonly kind: "idle" }
  | { readonly kind: "resolving"; readonly locator: PullRequestLocator }
  | {
      readonly kind: "choose-account";
      readonly locator: PullRequestLocator;
      readonly accounts: AccountChoice[];
    }
  | {
      readonly kind: "connect-account";
      readonly locator: PullRequestLocator;
      readonly phase: "entry" | "device-code";
    }
  | {
      readonly kind: "confirm-repository";
      readonly locator: PullRequestLocator;
      readonly clonePath: string | null;
    }
  | { readonly kind: "adding-repository"; readonly locator: PullRequestLocator }
  | {
      readonly kind: "error";
      readonly locator: PullRequestLocator;
      readonly reason: "forbidden" | "not-found" | "network";
      readonly message: string;
    };

let state = $state<PrDeepLinkState>({ kind: "idle" });
let loadingVisible = $state(false);
let activeRequest: AbortController | null = null;
let loadingTimer: ReturnType<typeof setTimeout> | null = null;
let requestVersion = 0;
let resolutionInFlight = false;
let completingAuthorization = false;
let accountRecoveryVersion = 0;

export function getPrDeepLinkState(): PrDeepLinkState {
  return state;
}

export function getPrDeepLinkLoadingVisible(): boolean {
  return loadingVisible;
}

export function matchingAccountsFor(host: string): AccountChoice[] {
  const normalized = host.toLowerCase();
  return getLocalAccounts().flatMap((localAccount) =>
    localAccount.accounts
      .filter((account) => account.host.toLowerCase() === normalized)
      .map((account) => ({
        userId: localAccount.id,
        host: account.host,
        login: account.githubLogin ?? localAccount.name,
        email: localAccount.email,
        avatarUrl: account.avatarUrl ?? localAccount.image,
      })),
  );
}

export function deepLinkNeedsClientId(locator: PullRequestLocator): boolean {
  if (locator.githubHost === "github.com") return false;
  return getGithubHost()?.toLowerCase() !== locator.githubHost || getGithubClientId().trim() === "";
}

export function getDeepLinkClientId(locator: PullRequestLocator): string {
  return getGithubHost()?.toLowerCase() === locator.githubHost ? getGithubClientId() : "";
}

function clearLoadingTimer(): void {
  if (loadingTimer) clearTimeout(loadingTimer);
  loadingTimer = null;
}

function cancelResolution(): void {
  requestVersion += 1;
  accountRecoveryVersion += 1;
  activeRequest?.abort();
  activeRequest = null;
  resolutionInFlight = false;
  clearLoadingTimer();
  loadingVisible = false;
}

async function surfaceWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
  } catch {
    // Browser development has no native window; resolving still works.
  }
}

function locatorLabel(locator: PullRequestLocator): string {
  return `${locator.repositoryFullName} #${locator.number}`;
}

async function safeErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // The fallback is intentionally safe and contains no transport internals.
  }
  return fallback;
}

async function showAccountRecovery(locator: PullRequestLocator): Promise<void> {
  const version = ++accountRecoveryVersion;
  await fetchLocalAccounts();
  if (version !== accountRecoveryVersion || state.kind === "idle") return;
  if (state.locator !== locator) return;
  const accounts = matchingAccountsFor(locator.githubHost);
  state =
    accounts.length > 0
      ? { kind: "choose-account", locator, accounts }
      : { kind: "connect-account", locator, phase: "entry" };
}

async function resolveActiveLocator(locator: PullRequestLocator): Promise<void> {
  if (resolutionInFlight) return;
  if (!getIsAuthenticated()) {
    // Keep a link received during first-run onboarding dormant until the existing
    // device flow finishes instead of starting a competing authorization.
    if (getDeviceFlow()) return;
    await showAccountRecovery(locator);
    return;
  }
  if (!getIsOnboarded()) return;

  resolutionInFlight = true;
  const version = ++requestVersion;
  const controller = new AbortController();
  activeRequest?.abort();
  activeRequest = controller;
  clearLoadingTimer();
  loadingVisible = false;
  state = { kind: "resolving", locator };
  loadingTimer = setTimeout(() => {
    if (requestVersion === version && state.kind === "resolving") loadingVisible = true;
  }, 250);

  try {
    const response = await fetch(`${API_BASE_URL}/api/prs/resolve-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(locator),
      signal: controller.signal,
    });
    if (version !== requestVersion) return;

    if (response.status === 401) {
      await showAccountRecovery(locator);
      return;
    }
    if (response.status === 403) {
      state = {
        kind: "error",
        locator,
        reason: "forbidden",
        message: `The selected account does not have access to ${locatorLabel(locator)}.`,
      };
      return;
    }
    if (response.status === 404) {
      state = {
        kind: "error",
        locator,
        reason: "not-found",
        message: `${locatorLabel(locator)} may have been deleted, or the link may be out of date.`,
      };
      return;
    }
    if (!response.ok) {
      state = {
        kind: "error",
        locator,
        reason: "network",
        message: await safeErrorMessage(
          response,
          "The local Revv server could not resolve this link.",
        ),
      };
      return;
    }

    const result = (await response.json()) as
      | { status: "resolved"; pullRequest: PullRequest }
      | { status: "account_mismatch"; activeHost: string; expectedHost: string }
      | { status: "repository_not_tracked" };
    if (version !== requestVersion) return;

    if (result.status === "account_mismatch") {
      await showAccountRecovery(locator);
      return;
    }
    if (result.status === "repository_not_tracked") {
      await fetchDefaultCloneBaseDir();
      const base = getDefaultCloneBaseDir()?.replace(/\/$/, "") ?? null;
      state = {
        kind: "confirm-repository",
        locator,
        clonePath: base ? `${base}/${locator.repositoryFullName}` : null,
      };
      return;
    }

    upsertPullRequest(result.pullRequest);
    state = { kind: "idle" };
    await goto(`/review/${encodeURIComponent(result.pullRequest.id)}`);
  } catch (error) {
    if (controller.signal.aborted || version !== requestVersion) return;
    state = {
      kind: "error",
      locator,
      reason: "network",
      message: error instanceof Error ? error.message : "Revv could not reach its local server.",
    };
  } finally {
    if (version === requestVersion) {
      resolutionInFlight = false;
      activeRequest = null;
      clearLoadingTimer();
      loadingVisible = false;
    }
  }
}

export async function openPrDeepLink(rawUrl: string): Promise<void> {
  const locator = parsePullRequestDeepLink(rawUrl);
  if (!locator) {
    toast.error("This Revv link is invalid.");
    return;
  }

  const wasAuthorizingFromDeepLink =
    state.kind === "connect-account" && state.phase === "device-code";
  cancelResolution();
  if (wasAuthorizingFromDeepLink) {
    cancelSignIn();
    clearError();
  }
  state = { kind: "resolving", locator };
  await surfaceWindow();
  await resolveActiveLocator(locator);
}

export function resumePendingPrDeepLink(): void {
  if (state.kind !== "resolving") return;
  if (!getIsAuthenticated()) {
    if (getDeviceFlow()) return;
    void showAccountRecovery(state.locator);
    return;
  }
  if (!getIsOnboarded()) return;
  void resolveActiveLocator(state.locator);
}

export async function choosePrDeepLinkAccount(account: AccountChoice): Promise<void> {
  if (state.kind !== "choose-account") return;
  const locator = state.locator;
  state = { kind: "resolving", locator };
  try {
    await switchAccount(account.userId, account.host);
    await updateSettings({ githubHost: account.host }, { strict: true });
    if (getIsAuthenticated() && getIsOnboarded()) await resolveActiveLocator(locator);
  } catch (error) {
    state = {
      kind: "error",
      locator,
      reason: "network",
      message: error instanceof Error ? error.message : "Revv could not switch accounts.",
    };
  }
}

export async function connectPrDeepLinkAccount(clientId: string): Promise<string | null> {
  if (state.kind !== "connect-account") return null;
  const locator = state.locator;
  const trimmedClientId = clientId.trim();
  if (locator.githubHost !== "github.com" && !isLikelyGitHubClientId(trimmedClientId)) {
    return GITHUB_CLIENT_ID_HINT;
  }

  clearError();
  try {
    await setGithubConfigStrict(
      locator.githubHost,
      locator.githubHost === "github.com" ? "" : trimmedClientId,
    );
    const started = await signIn(locator.githubHost);
    if (!started) return getError() ?? "Failed to start authorization.";
    state = { kind: "connect-account", locator, phase: "device-code" };
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function settlePrDeepLinkAuthorization(authError: string | null): Promise<void> {
  if (
    state.kind !== "connect-account" ||
    state.phase !== "device-code" ||
    completingAuthorization
  ) {
    return;
  }
  if (authError) {
    state = { ...state, phase: "entry" };
    return;
  }

  completingAuthorization = true;
  const locator = state.locator;
  try {
    await fetchLocalAccounts();
    const email = getUser()?.email;
    const account = matchingAccountsFor(locator.githubHost).find(
      (choice) => email === undefined || choice.email === email,
    );
    if (account) {
      await switchAccount(account.userId, account.host);
      await updateSettings({ githubHost: account.host }, { strict: true });
    }
    state = { kind: "resolving", locator };
    if (getIsOnboarded()) await resolveActiveLocator(locator);
  } catch (error) {
    state = {
      kind: "error",
      locator,
      reason: "network",
      message: error instanceof Error ? error.message : "Revv could not activate this account.",
    };
  } finally {
    completingAuthorization = false;
  }
}

export async function addPrDeepLinkRepository(): Promise<void> {
  if (state.kind !== "confirm-repository") return;
  const locator = state.locator;
  state = { kind: "adding-repository", locator };
  try {
    const response = await fetch(`${API_BASE_URL}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ fullName: locator.repositoryFullName, mode: "clone" }),
    });
    if (!response.ok) {
      const reason =
        response.status === 403 ? "forbidden" : response.status === 404 ? "not-found" : "network";
      state = {
        kind: "error",
        locator,
        reason,
        message: await safeErrorMessage(response, "Revv could not add this repository."),
      };
      return;
    }
    await fetchRepos();
    state = { kind: "resolving", locator };
    await resolveActiveLocator(locator);
  } catch (error) {
    state = {
      kind: "error",
      locator,
      reason: "network",
      message: error instanceof Error ? error.message : "Revv could not add this repository.",
    };
  }
}

export function retryPrDeepLink(): void {
  if (state.kind !== "error") return;
  const locator = state.locator;
  state = { kind: "resolving", locator };
  void resolveActiveLocator(locator);
}

export function chooseAnotherPrDeepLinkAccount(): void {
  if (state.kind !== "error") return;
  void showAccountRecovery(state.locator);
}

export function dismissPrDeepLink(): void {
  const wasAuthorizing = state.kind === "connect-account" && state.phase === "device-code";
  cancelResolution();
  state = { kind: "idle" };
  if (wasAuthorizing) cancelSignIn();
}
