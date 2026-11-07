// The signed-in session's lifecycle, in one ordered place: start (realtime
// stream + first reads), switch to another local account, and end (sign-out,
// account removal, host change). Nothing it imports may import it back.
//
// Sync cadence is the server's PollScheduler alone (it restarts itself when
// `autoFetchInterval` changes); the client never polls GitHub on a timer.

import { sameGithubHost } from "@revv/shared";
import { goto } from "$app/navigation";
import { reset as resetChat } from "$lib/chat/turn.svelte";
import { reset as resetHunkScan } from "$lib/hunk-scan/store.svelte";
import { reset as resetRecaps } from "$lib/recaps/store.svelte";
import { reset as resetRecapStream } from "$lib/recaps/stream.svelte";
import { reset as resetRepoCatalog } from "$lib/repos/catalog.svelte";
import { reset as resetPrCommits } from "$lib/review/pr-commits.svelte";
import { reset as resetPulls } from "$lib/review/pull-latest";
import {
  cancelSignIn,
  clearIdentity,
  deleteAccount,
  dismissAccountPicker,
  fetchLocalAccounts,
  getError,
  getIsAuthenticated,
  getIsSwitching,
  getUser,
  loadUser,
  requestAccountSwitch,
  runAccountSwitch,
} from "$lib/stores/auth.svelte";
import { reset as resetBaseConflicts } from "$lib/stores/base-conflicts.svelte";
import { reset as resetConversation } from "$lib/stores/conversation.svelte";
import { reset as resetDiffFiles } from "$lib/stores/diff-files.svelte";
import { connect, disconnect } from "$lib/stores/events.svelte";
import { reset as resetMergeEligibility } from "$lib/stores/merge-eligibility.svelte";
import { reset as resetOrgTeams } from "$lib/stores/org-teams.svelte";
import { reset as resetPrFilters } from "$lib/stores/pr-filters.svelte";
import { reset as resetPrViewState } from "$lib/stores/pr-view-state.svelte";
import { fetchPinnedPrs, fetchPrs, reset as resetPrs } from "$lib/stores/prs.svelte";
import { reset as resetRepoActivity } from "$lib/stores/repo-activity.svelte";
import { fetchRepos, reset as resetRepos } from "$lib/stores/repos.svelte";
import { reset as resetReview } from "$lib/stores/review.svelte";
import { reset as resetReviewNav } from "$lib/stores/review-nav.svelte";
import { isOnAccountPage } from "$lib/stores/route.svelte";
import {
  fetchAllModels,
  fetchSettings,
  getGithubHost,
  resetModels,
  setGithubConfig,
  updateSettings,
} from "$lib/stores/settings.svelte";
import { reset as resetStackHeadlines } from "$lib/stores/stack-headlines.svelte";
import { reset as resetStackMerge } from "$lib/stores/stack-merge.svelte";
import { reset as resetStackRebase } from "$lib/stores/stack-rebase.svelte";
import { reset as resetStacks } from "$lib/stores/stacks.svelte";
import { reset as resetSync } from "$lib/stores/sync.svelte";
import { reset as resetWalkthroughSizings } from "$lib/walkthrough/sizing.svelte";
import { reset as resetWalkthrough } from "$lib/walkthrough/store.svelte";
import { accountEntryKey } from "./account-entries";
import { heldToken, releaseSession } from "./held-sessions";
import { getToken, setToken } from "./token.svelte";

let sessionUserId: string | null = null;
let switchingTo = $state<string | null>(null);

/**
 * Every store that holds data read under the session. A new one adds its
 * reset here. The settings row is not on the list: the server keeps one
 * machine-wide row, which onboarding reads before anyone signs in.
 */
function resetAccountStores(): void {
  resetModels();
  resetPrs();
  resetPrFilters();
  resetRepos();
  resetRepoCatalog();
  resetOrgTeams();
  resetReview();
  resetReviewNav();
  resetDiffFiles();
  resetPrViewState();
  resetPulls();
  resetPrCommits();
  resetSync();
  resetWalkthrough();
  resetWalkthroughSizings();
  resetHunkScan();
  resetChat();
  resetConversation();
  resetRecaps();
  resetRecapStream();
  resetStacks();
  resetStackHeadlines();
  resetStackMerge();
  resetStackRebase();
  resetMergeEligibility();
  resetRepoActivity();
  resetBaseConflicts();
}

/**
 * First step on launch: restore the stored session, or, signed out, list the
 * held sessions the account picker offers.
 */
export function restoreSession(): void {
  void (getToken() ? loadUser() : fetchLocalAccounts());
}

/**
 * Start the session for `userId`, once: open the realtime stream, then read
 * the account's lists. The root layout calls this whenever an identity
 * appears (restore, sign-in); repeat calls for the same user no-op. An
 * account switch starts its own session once the new host is written.
 */
export function startSession(userId: string): void {
  if (!getIsSwitching()) beginSession(userId);
}

function beginSession(userId: string): void {
  if (sessionUserId === userId) return;
  if (sessionUserId !== null) {
    disconnect();
    resetAccountStores();
  }
  sessionUserId = userId;
  connect();
  void Promise.allSettled([
    fetchSettings(),
    fetchAllModels(),
    fetchPrs(),
    fetchRepos(),
    fetchPinnedPrs(),
  ]);
}

function stopSession(): void {
  disconnect();
  resetAccountStores();
  sessionUserId = null;
}

/** Drop the realtime stream without ending the session (root layout teardown). */
export function detachSession(): void {
  disconnect();
  sessionUserId = null;
}

/**
 * Switch to another local account. Signed in, the server mints its session;
 * signed out, the session this machine holds for it is presented. Persists
 * `host` as the active GitHub host before the new account's settings are
 * read. Resolves `false` when the switch failed; the reason is the auth
 * store's sign-in error.
 */
export async function switchSession(userId: string, host?: string): Promise<boolean> {
  switchingTo = accountEntryKey(userId, host ?? "");
  try {
    return await runAccountSwitch(() => runSwitch(userId, host));
  } finally {
    switchingTo = null;
  }
}

async function runSwitch(userId: string, host: string | undefined): Promise<void> {
  const token = getToken() ? await requestAccountSwitch(userId) : heldToken(userId);
  if (token === null) throw new Error("This account is signed out. Sign in again.");
  stopSession();
  setToken(token);
  // Not awaited: `goto` waits on SvelteKit's load/render cycle, and the
  // session below starts the same way whichever route ends up showing.
  if (isOnAccountPage()) {
    void goto("/", { replaceState: true });
  }
  // The switch blocks only on the identity round-trip (and the host write
  // the settings read depends on); the lists load in the background.
  const [hostWrite] = await Promise.allSettled([
    host ? updateSettings({ githubHost: host }, { strict: true }) : undefined,
    loadUser(),
  ]);
  const user = getUser();
  if (!user) {
    throw new Error(getError() ?? "This account's session has ended. Sign in again.");
  }
  beginSession(user.id);
  if (hostWrite.status === "rejected") throw hostWrite.reason;
}

/** The {@link accountEntryKey} of the account a switch is running to. */
export function getSwitchingTo(): string | null {
  return switchingTo;
}

/**
 * End the session locally: stream, account data, identity and token. The
 * session stays held, so the account picker offers it again.
 */
export function endSession(): void {
  stopSession();
  clearIdentity();
}

/**
 * Point Revv at another GitHub host. A session belongs to its host, so a
 * signed-in one ends first and the caller signs in on the new host.
 */
export async function changeGithubHost(host: string, clientId: string): Promise<void> {
  if (getIsAuthenticated() && !sameGithubHost(getGithubHost(), host)) {
    dismissAccountPicker();
    cancelSignIn();
    endSession();
  }
  await setGithubConfig(host, clientId);
}

/**
 * Sign this window out. The server session stays: other signed-in users on the
 * machine can still switch to this one, and this window can switch back.
 */
export async function signOut(): Promise<void> {
  endSession();
  await goto("/");
}

/** Delete the signed-in account on the server, then end its session. Throws when the server refuses. */
export async function removeAccount(): Promise<void> {
  const userId = getUser()?.id;
  await deleteAccount();
  if (userId) releaseSession({ userId });
  dismissAccountPicker();
  endSession();
  await goto("/");
}
