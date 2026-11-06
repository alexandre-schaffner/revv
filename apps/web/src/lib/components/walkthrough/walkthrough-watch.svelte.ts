// What keeps a PR's walkthrough honest while its review page is open: the
// first snapshot, a valid report on screen, a stalled stream reconciled
// against the DB, a waiting run started once its repo is cloned, and one
// toast per failure. Called by the review page during its init.

import type { WalkthroughReviewRound } from "@revv/shared";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { getRepoById } from "$lib/stores/repos.svelte";
import { openSettings } from "$lib/stores/settingsModal.svelte";
import {
  getLastWalkthroughEventAt,
  getReviewRounds,
  getSelectedReportId,
  getWalkthroughEntry,
  hydrateFromCache,
  loadReviewRounds,
  selectWalkthroughReport,
  watchWalkthrough,
} from "$lib/stores/walkthrough.svelte";
import { startWalkthrough, startWhenCloned, stopClonePoll } from "$lib/stores/walkthrough-actions";
import {
  agentAuthRecoveryDescription,
  isAgentAuthRecoveryError,
} from "$lib/utils/agent-auth-recovery";

/**
 * The report a PR's page should show when the one on screen isn't a visible
 * round: the newest finished visible round, current head first.
 */
function defaultReport(
  rounds: readonly WalkthroughReviewRound[],
  currentHeadSha: string | null,
): WalkthroughReviewRound | null {
  const visible = rounds
    .filter((round) => round.visibility !== "hidden")
    .sort((a, b) => {
      const aCurrent = currentHeadSha !== null && a.toSha === currentHeadSha;
      const bCurrent = currentHeadSha !== null && b.toSha === currentHeadSha;
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      const aTime = Date.parse(a.completedAt ?? a.createdAt);
      const bTime = Date.parse(b.completedAt ?? b.createdAt);
      if (aTime !== bTime) return bTime - aTime;
      return b.roundNumber - a.roundNumber;
    });
  return visible.find((round) => round.status !== "generating") ?? visible[0] ?? null;
}

function isVisibleRound(rounds: readonly WalkthroughReviewRound[], walkthroughId: string | null) {
  return (
    walkthroughId !== null &&
    rounds.some((round) => round.visibility !== "hidden" && round.walkthroughId === walkthroughId)
  );
}

// A run's terminal envelope can miss this client (a fast failure racing the
// SSE registration) while heartbeats keep the connection alive, which would
// leave it "generating" forever. Silence past the threshold re-reads
// `/current`. `lifecycle:started` lands within a second or two of Generate;
// after that the server's `phase` heartbeat comes every 45 s.
const STREAM_START_STALL_MS = 20_000;
const STREAM_STALL_MS = 90_000;
const STALL_CHECK_INTERVAL_MS = 5_000;

export function useWalkthroughWatch(getPrId: () => string, getIsShown: () => boolean): void {
  const prId = $derived(getPrId());
  const entry = $derived(getWalkthroughEntry(prId));
  const isStreaming = $derived(entry?.isStreaming ?? false);
  const streamError = $derived(entry?.streamError ?? null);
  const cloneRepoId = $derived(entry?.cloneInProgress ? entry.cloneRepoId : null);
  const cloneRepo = $derived(cloneRepoId ? getRepoById(cloneRepoId) : null);

  $effect(() => {
    const id = prId;
    if (!id) return;
    const unwatch = untrack(() => {
      void loadReviewRounds(id);
      return watchWalkthrough(id);
    });
    return () => {
      unwatch();
      stopClonePoll(id);
    };
  });

  let reportLoading = false;
  let autoSelectedFor: string | null = null;
  $effect(() => {
    const rounds = getReviewRounds(prId);
    const candidate = rounds ? defaultReport(rounds.rounds, rounds.currentHeadSha ?? null) : null;
    if (
      !rounds ||
      !candidate ||
      getSelectedReportId(prId) !== null ||
      isVisibleRound(rounds.rounds, entry?.walkthroughId ?? null) ||
      isStreaming ||
      reportLoading
    ) {
      return;
    }
    const key = `${prId}:${candidate.walkthroughId}`;
    if (autoSelectedFor === key) return;
    autoSelectedFor = key;
    reportLoading = true;
    void selectWalkthroughReport(prId, candidate.walkthroughId).finally(() => {
      reportLoading = false;
    });
  });

  let lastReconcileAt = 0;
  $effect(() => {
    if (!isStreaming || cloneRepoId) return;
    const id = prId;
    const timer = setInterval(() => {
      const watchedEntry = getWalkthroughEntry(id);
      const threshold = watchedEntry?.liveGeneration ? STREAM_STALL_MS : STREAM_START_STALL_MS;
      const now = Date.now();
      const lastActivity = Math.max(
        getLastWalkthroughEventAt(id) ?? 0,
        watchedEntry?.streamStartedAt ?? 0,
      );
      // At most once per window: a row still generating keeps `isStreaming`
      // without moving the activity clock.
      if (now - lastActivity <= threshold || now - lastReconcileAt <= threshold) return;
      lastReconcileAt = now;
      void hydrateFromCache(id);
    }, STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  $effect(() => {
    const repoId = cloneRepoId;
    if (!repoId) return;
    const id = prId;
    // The repo's SSE status is the fast path; the poll covers a missed one.
    if (cloneRepo?.cloneStatus === "ready") {
      void startWalkthrough(id);
      return;
    }
    void startWhenCloned(id, repoId);
    return () => stopClonePoll(id);
  });

  let lastStreamErrorToast: string | null = null;
  $effect(() => {
    if (!streamError) {
      lastStreamErrorToast = null;
      return;
    }
    if (!getIsShown()) return;
    const key = `${prId}:${streamError}`;
    if (lastStreamErrorToast === key) return;
    lastStreamErrorToast = key;
    const authRecovery = isAgentAuthRecoveryError(streamError);
    toast.error("Walkthrough failed", {
      id: `walkthrough-error-${prId}`,
      description: authRecovery ? agentAuthRecoveryDescription(streamError) : streamError,
      ...(authRecovery
        ? { action: { label: "Open Settings", onClick: () => openSettings("ai") } }
        : {}),
      duration: 8000,
    });
  });

  let lastCloneErrorToast: string | null = null;
  $effect(() => {
    const cloneError = cloneRepo?.cloneError || null;
    if (!cloneError) {
      lastCloneErrorToast = null;
      return;
    }
    if (!getIsShown()) return;
    const key = `${cloneRepoId ?? "unknown"}:${cloneError}`;
    if (lastCloneErrorToast === key) return;
    lastCloneErrorToast = key;
    toast.error("Repository clone failed", {
      id: `repo-clone-error-${cloneRepoId ?? prId}`,
      description: cloneError,
      duration: 8000,
    });
  });
}
