import {
  GITHUB_CLIENT_ID_HINT,
  isLikelyGitHubClientId,
  isPublicGitHub,
  type PullRequestLocator,
  parsePullRequestDeepLink,
  sameGithubHost,
  savedClientIdForHost,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { api } from "$lib/api/client";
import { apiErrorCode, call } from "$lib/api/errors";
import { type EdenData, thrownMessage } from "$lib/api/wire";
import { clonePathPreview } from "$lib/repos/add-repo";
import { fetchDefaultCloneBaseDir, getDefaultCloneBaseDir } from "$lib/repos/catalog.svelte";
import { type AccountEntry, accountEntries } from "$lib/session/account-entries";
import { switchSession } from "$lib/session/lifecycle.svelte";
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
} from "$lib/stores/auth.svelte";
import { upsertPullRequest } from "$lib/stores/prs.svelte";
import { AddRepoError, addRepo } from "$lib/stores/repos.svelte";
import {
  getGithubClientId,
  getGithubHost,
  setGithubConfigStrict,
} from "$lib/stores/settings.svelte";
import { surfaceWindow } from "$lib/utils/surface-window";

export type PrDeepLinkState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "resolving";
      readonly locator: PullRequestLocator;
      readonly phase: "pending" | "active";
      readonly loadingVisible: boolean;
    }
  | {
      readonly kind: "choose-account";
      readonly locator: PullRequestLocator;
      readonly accounts: AccountEntry[];
    }
  | {
      readonly kind: "connect-account";
      readonly locator: PullRequestLocator;
      readonly phase: "entry";
    }
  | {
      readonly kind: "connect-account";
      readonly locator: PullRequestLocator;
      readonly phase: "device-code";
      readonly clientId: string;
    }
  | {
      readonly kind: "connect-account";
      readonly locator: PullRequestLocator;
      readonly phase: "settling";
      readonly clientId: string;
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
let activeRequest: AbortController | null = null;
let loadingTimer: ReturnType<typeof setTimeout> | null = null;
let requestVersion = 0;

export function getPrDeepLinkState(): PrDeepLinkState {
  return state;
}

export function getPrDeepLinkLoadingVisible(): boolean {
  return state.kind === "resolving" && state.loadingVisible;
}

function pendingResolution(locator: PullRequestLocator): PrDeepLinkState {
  return { kind: "resolving", locator, phase: "pending", loadingVisible: false };
}

export function matchingAccountsFor(host: string): AccountEntry[] {
  return accountEntries(getLocalAccounts()).filter((entry) => sameGithubHost(entry.host, host));
}

function savedClientId(locator: PullRequestLocator): string | null {
  return savedClientIdForHost(locator.githubHost, {
    githubHost: getGithubHost(),
    githubClientId: getGithubClientId(),
  });
}

export function deepLinkNeedsClientId(locator: PullRequestLocator): boolean {
  return !isPublicGitHub(locator.githubHost) && savedClientId(locator) === null;
}

export function getDeepLinkClientId(locator: PullRequestLocator): string {
  return savedClientId(locator) ?? "";
}

function clearLoadingTimer(): void {
  if (loadingTimer) clearTimeout(loadingTimer);
  loadingTimer = null;
}

function cancelResolution(): void {
  requestVersion += 1;
  activeRequest?.abort();
  activeRequest = null;
  clearLoadingTimer();
}

async function switchTo(account: AccountEntry): Promise<void> {
  if (!(await switchSession(account.userId, account.host))) {
    throw new Error(getError() ?? "Revv could not switch accounts.");
  }
}

function locatorLabel(locator: PullRequestLocator): string {
  return `${locator.repositoryFullName} #${locator.number}`;
}

async function showAccountRecovery(locator: PullRequestLocator): Promise<void> {
  const version = ++requestVersion;
  await fetchLocalAccounts();
  if (version !== requestVersion || state.kind === "idle") return;
  if (state.locator !== locator) return;
  const accounts = matchingAccountsFor(locator.githubHost);
  state =
    accounts.length > 0
      ? { kind: "choose-account", locator, accounts }
      : { kind: "connect-account", locator, phase: "entry" };
}

async function resolveActiveLocator(locator: PullRequestLocator): Promise<void> {
  if (state.kind === "resolving" && state.phase === "active") return;
  if (!getIsAuthenticated()) {
    // Keep a link received during first-run onboarding dormant until the existing
    // device flow finishes instead of starting a competing authorization.
    if (getDeviceFlow()) return;
    await showAccountRecovery(locator);
    return;
  }
  if (!getIsOnboarded()) return;

  const version = ++requestVersion;
  const controller = new AbortController();
  activeRequest?.abort();
  activeRequest = controller;
  clearLoadingTimer();
  state = { kind: "resolving", locator, phase: "active", loadingVisible: false };
  loadingTimer = setTimeout(() => {
    if (requestVersion === version && state.kind === "resolving" && state.phase === "active") {
      state = { ...state, loadingVisible: true };
    }
  }, 250);

  let result: EdenData<(typeof api.api.prs)["resolve-link"]["post"]>;
  try {
    result = await call(
      api.api.prs["resolve-link"].post(locator, { fetch: { signal: controller.signal } }),
      "The local Revv server could not resolve this link",
    );
  } catch (error) {
    if (controller.signal.aborted || version !== requestVersion) return;
    const code = apiErrorCode(error);
    if (code === "UNAUTHORIZED" || code === "GITHUB_AUTH_ERROR") {
      await showAccountRecovery(locator);
    } else {
      state = {
        kind: "error",
        locator,
        reason: code === "FORBIDDEN" ? "forbidden" : code === "NOT_FOUND" ? "not-found" : "network",
        message:
          code === "FORBIDDEN"
            ? `The selected account does not have access to ${locatorLabel(locator)}.`
            : code === "NOT_FOUND"
              ? `${locatorLabel(locator)} may have been deleted, or the link may be out of date.`
              : thrownMessage(error),
      };
    }
    finishResolution(version);
    return;
  }
  if (version !== requestVersion) return;

  try {
    if (result.status === "account_mismatch") {
      await showAccountRecovery(locator);
      return;
    }
    if (result.status === "repository_not_tracked") {
      await fetchDefaultCloneBaseDir();
      const base = getDefaultCloneBaseDir();
      state = {
        kind: "confirm-repository",
        locator,
        clonePath: base ? clonePathPreview(base, locator.repositoryFullName) : null,
      };
      return;
    }

    upsertPullRequest(result.pullRequest);
    state = { kind: "idle" };
    await goto(`/review/${result.pullRequest.id}`);
  } catch (error) {
    if (version !== requestVersion) return;
    state = { kind: "error", locator, reason: "network", message: thrownMessage(error) };
  } finally {
    finishResolution(version);
  }
}

function finishResolution(version: number): void {
  if (version !== requestVersion) return;
  activeRequest = null;
  clearLoadingTimer();
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
  state = pendingResolution(locator);
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

export async function choosePrDeepLinkAccount(account: AccountEntry): Promise<void> {
  if (state.kind !== "choose-account") return;
  const locator = state.locator;
  state = pendingResolution(locator);
  try {
    await switchTo(account);
    if (getIsAuthenticated() && getIsOnboarded()) await resolveActiveLocator(locator);
  } catch (error) {
    state = {
      kind: "error",
      locator,
      reason: "network",
      message: thrownMessage(error),
    };
  }
}

export async function connectPrDeepLinkAccount(clientId: string): Promise<string | null> {
  if (state.kind !== "connect-account") return null;
  const locator = state.locator;
  const trimmedClientId = clientId.trim();
  if (!isPublicGitHub(locator.githubHost) && !isLikelyGitHubClientId(trimmedClientId)) {
    return GITHUB_CLIENT_ID_HINT;
  }

  clearError();
  try {
    const clientId = isPublicGitHub(locator.githubHost) ? "" : trimmedClientId;
    const started = await signIn(locator.githubHost, clientId);
    if (!started) return getError() ?? "Failed to start authorization.";
    state = { kind: "connect-account", locator, phase: "device-code", clientId };
    return null;
  } catch (error) {
    return thrownMessage(error);
  }
}

export async function settlePrDeepLinkAuthorization(authError: string | null): Promise<void> {
  if (state.kind !== "connect-account" || state.phase !== "device-code") {
    return;
  }
  if (authError) {
    state = { kind: "connect-account", locator: state.locator, phase: "entry" };
    return;
  }

  const locator = state.locator;
  const clientId = state.clientId;
  const version = ++requestVersion;
  state = { kind: "connect-account", locator, phase: "settling", clientId };
  try {
    // The deep link's host/client ID are transient device-flow inputs. Persist
    // them globally only after GitHub has actually authorized the account.
    await setGithubConfigStrict(locator.githubHost, clientId);
    if (version !== requestVersion) return;
    await fetchLocalAccounts();
    if (version !== requestVersion) return;
    const email = getUser()?.email;
    const account = matchingAccountsFor(locator.githubHost).find(
      (choice) => email === undefined || choice.email === email,
    );
    if (account) {
      await switchTo(account);
      if (version !== requestVersion) return;
    }
    state = pendingResolution(locator);
    if (getIsOnboarded()) await resolveActiveLocator(locator);
  } catch (error) {
    state = {
      kind: "error",
      locator,
      reason: "network",
      message: thrownMessage(error),
    };
  }
}

export async function addPrDeepLinkRepository(): Promise<void> {
  if (state.kind !== "confirm-repository") return;
  const locator = state.locator;
  state = { kind: "adding-repository", locator };
  try {
    await addRepo({ fullName: locator.repositoryFullName, mode: "clone" });
    state = pendingResolution(locator);
    await resolveActiveLocator(locator);
  } catch (error) {
    state = {
      kind: "error",
      locator,
      reason: refusalReason(error),
      message: thrownMessage(error),
    };
  }
}

function refusalReason(error: unknown): "forbidden" | "not-found" | "network" {
  const code = error instanceof AddRepoError ? error.code : null;
  return code === "FORBIDDEN" ? "forbidden" : code === "NOT_FOUND" ? "not-found" : "network";
}

export function retryPrDeepLink(): void {
  if (state.kind !== "error") return;
  const locator = state.locator;
  state = pendingResolution(locator);
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
