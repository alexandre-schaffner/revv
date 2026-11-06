// The signed-in session's lifecycle, in one ordered place: start (realtime
// stream + first reads), switch to another local account, and end (sign-out,
// account removal, host change). Imported by the root layout and the auth UI;
// nothing below it imports it back.
//
// Sync cadence is the server's PollScheduler alone (it restarts itself when
// `autoFetchInterval` changes); the client never polls GitHub on a timer.

import { goto } from "$app/navigation";
import { reset as resetRepoCatalog } from "$lib/repos/catalog.svelte";
import { reset as resetPulls } from "$lib/review/pull-latest";
import {
  clearIdentity,
  deleteAccount,
  fetchLocalAccounts,
  getIsSwitching,
  getUser,
  loadUser,
  markAccountRemoved,
  requestAccountSwitch,
  revokeSession,
  runAccountSwitch,
} from "$lib/stores/auth.svelte";
import { reset as resetBaseConflicts } from "$lib/stores/base-conflicts.svelte";
import { reset as resetChat } from "$lib/stores/chat.svelte";
import { reset as resetConversation } from "$lib/stores/conversation.svelte";
import { reset as resetDiffFiles } from "$lib/stores/diff-files.svelte";
import { connect, disconnect } from "$lib/stores/events.svelte";
import { reset as resetHunkScan } from "$lib/stores/hunk-scan.svelte";
import { reset as resetMergeEligibility } from "$lib/stores/merge-eligibility.svelte";
import { reset as resetOrgTeams } from "$lib/stores/org-teams.svelte";
import { reset as resetPrFilters } from "$lib/stores/pr-filters.svelte";
import { reset as resetPrViewState } from "$lib/stores/pr-view-state.svelte";
import { fetchPinnedPrs, fetchPrs, reset as resetPrs } from "$lib/stores/prs.svelte";
import { reset as resetRecapStream } from "$lib/stores/recap-stream.svelte";
import { reset as resetRecaps } from "$lib/stores/recaps.svelte";
import { reset as resetRepoActivity } from "$lib/stores/repo-activity.svelte";
import { fetchRepos, reset as resetRepos } from "$lib/stores/repos.svelte";
import { reset as resetReview } from "$lib/stores/review.svelte";
import { isOnAccountPage } from "$lib/stores/route.svelte";
import { fetchSettings, updateSettings } from "$lib/stores/settings.svelte";
import { reset as resetStackHeadlines } from "$lib/stores/stack-headlines.svelte";
import { reset as resetStackMerge } from "$lib/stores/stack-merge.svelte";
import { reset as resetStackRebase } from "$lib/stores/stack-rebase.svelte";
import { reset as resetStacks } from "$lib/stores/stacks.svelte";
import { reset as resetSuggestions } from "$lib/stores/suggestions.svelte";
import { reset as resetSync } from "$lib/stores/sync.svelte";
import { reset as resetWalkthrough } from "$lib/stores/walkthrough.svelte";
import { reset as resetWalkthroughSizings } from "$lib/stores/walkthrough-sizing.svelte";
import { setToken } from "./token.svelte";

/** The user whose session is running; null between sessions. */
let sessionUserId: string | null = null;
/**
 * The GitHub host an account switch targets. The settings store may not hold
 * it yet, so the realtime stream is told the host explicitly and binds to the
 * right account on its first attempt.
 */
let sessionHost: string | undefined;

/**
 * Every store that holds account data. A new one adds its reset here.
 * Settings are not on the list: the server keeps one machine-wide row.
 */
function resetAccountStores(): void {
  resetPrs();
  resetPrFilters();
  resetRepos();
  resetRepoCatalog();
  resetOrgTeams();
  resetReview();
  resetDiffFiles();
  resetPrViewState();
  resetPulls();
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
  resetSuggestions();
  resetMergeEligibility();
  resetRepoActivity();
  resetBaseConflicts();
}

/** First step on launch: restore the stored session, and list the machine's accounts for the lock screen. */
export function restoreSession(): void {
  void fetchLocalAccounts();
  void loadUser();
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
  connect(sessionHost);
  void Promise.allSettled([fetchSettings(), fetchPrs(), fetchRepos(), fetchPinnedPrs()]);
}

function stopSession(): void {
  disconnect();
  resetAccountStores();
  sessionUserId = null;
  sessionHost = undefined;
}

/** Drop the realtime stream without ending the session (root layout teardown). */
export function detachSession(): void {
  disconnect();
  sessionUserId = null;
}

/**
 * Switch to another local account. Persists `host` as the active GitHub host
 * before the new account's settings are read. Resolves `false` when the
 * switch failed; the reason is the auth store's sign-in error.
 */
export function switchSession(userId: string, host?: string): Promise<boolean> {
  return runAccountSwitch(async () => {
    const token = await requestAccountSwitch(userId);
    stopSession();
    setToken(token);
    sessionHost = host;
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
    if (user) beginSession(user.id);
    if (hostWrite.status === "rejected") throw hostWrite.reason;
  });
}

/** End the session locally: stream, account data, identity and token. */
export function endSession(): void {
  stopSession();
  clearIdentity();
}

export async function signOut(): Promise<void> {
  await revokeSession();
  endSession();
  await goto("/");
}

/** Delete the signed-in account on the server, then end its session. Throws when the server refuses. */
export async function removeAccount(): Promise<void> {
  await deleteAccount();
  endSession();
  markAccountRemoved();
  await fetchLocalAccounts();
  await goto("/");
}
