// In-app updater: a check when started (the caller delays the start so the
// first check doesn't compete with the initial PR sync), then hourly. An
// update shows a persistent toast; nothing installs without the user's click.
//
// Every toast this module raises shares one Sonner id: the update toast is
// `duration: Infinity`, so without it the hourly tick would stack a fresh card
// on top of the one already on screen, and the install/error/restart toasts
// would pile up beside it.
//
// Dismissing a version silences that exact version for good (persisted), so a
// newer release notifies again, and Settings → "Check now" always answers.
// Sonner routes the × and swipe-to-dismiss through `onDismiss` and the
// Dismiss button through `cancel.onClick`; both count as a dismissal.

import { UPDATE_STABLE_COOLDOWN_MS } from "@revv/shared";
import Download from "phosphor-svelte/lib/Download";
import { toast } from "svelte-sonner";
import { thrownMessage } from "$lib/api/wire";
import { getIsMaintainer } from "$lib/stores/auth.svelte";
import { readStored, STORAGE_KEYS, textCodec, writeStored } from "$lib/stores/persisted.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { checkForUpdate, type UpdateInfo } from "./client";

const HOURLY_MS = 60 * 60 * 1000;

const TOAST_ID = "revv-updater";

let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
/**
 * In-memory mirror of the stored dismissal, so a dismissal still holds for
 * the rest of the session even if the write didn't land.
 */
let dismissedVersion: string | null = null;
/** Version currently advertised by an on-screen toast, if any. */
let notifiedVersion: string | null = null;
let pending: Promise<void> | null = null;

export function startUpdater(): void {
  if (started) return;
  started = true;
  void runCheck();
  intervalId = setInterval(() => {
    void runCheck();
  }, HOURLY_MS);
}

export function stopUpdater(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  started = false;
}

/**
 * A `manual` check (Settings) always ends in a toast, even "up to date", and
 * bypasses dismissals and the stable cooldown. A background tick that lands
 * during another check joins it; a manual one queues behind it.
 */
export function runCheck(options: { manual?: boolean } = {}): Promise<void> {
  if (pending && !options.manual) return pending;
  // `check()` never rejects — it reports failures as toasts — so the chain
  // can't be poisoned by a rejected link.
  const next = (pending ?? Promise.resolve()).then(() => check(options));
  pending = next;
  void next.then(() => {
    if (pending === next) pending = null;
  });
  return next;
}

async function check(options: { manual?: boolean }): Promise<void> {
  try {
    const update = await checkForUpdate();
    if (!update) {
      notifiedVersion = null;
      if (options.manual) {
        toast.success("You're up to date", {
          id: TOAST_ID,
          description: "No new version available.",
        });
      }
      return;
    }
    if (!options.manual && isDismissed(update.version)) {
      return;
    }
    if (!options.manual && update.version === notifiedVersion) {
      // The toast for this version is already on screen from an earlier
      // tick. Re-raising it would only reset its position in the stack.
      return;
    }
    if (!shouldNotify(update, options.manual ?? false)) {
      return;
    }
    showUpdateToast(update);
  } catch (err) {
    // Background checks fail silently: offline or endpoint down.
    console.error("updater check failed", err);
    if (options.manual) {
      toast.error("Update check failed", {
        id: TOAST_ID,
        description: thrownMessage(err),
      });
    }
  }
}

/**
 * The 48-hour stable-channel cooldown lives entirely in the client. Manual
 * checks, maintainers, and nightly users all bypass it — the gate exists to
 * delay *passive* notifications for regular users so maintainers can spot
 * fatal regressions in the first two days before the rest of the userbase is
 * pulled along.
 */
function shouldNotify(update: UpdateInfo, manual: boolean): boolean {
  if (manual) return true;
  if (getIsMaintainer()) return true;
  if (getSettings().updateChannel === "nightly") return true;
  if (!update.publishedAt) {
    // Fail open: a release CI forgot to stamp must not be suppressed forever.
    return true;
  }
  const publishedMs = Date.parse(update.publishedAt);
  if (Number.isNaN(publishedMs)) return true;
  return Date.now() - publishedMs >= UPDATE_STABLE_COOLDOWN_MS;
}

function isDismissed(version: string): boolean {
  if (version === dismissedVersion) return true;
  return readStored(STORAGE_KEYS.dismissedUpdate, textCodec, null) === version;
}

function rememberDismissal(version: string): void {
  dismissedVersion = version;
  notifiedVersion = null;
  writeStored(STORAGE_KEYS.dismissedUpdate, textCodec, version);
}

function showUpdateToast(update: UpdateInfo): void {
  notifiedVersion = update.version;
  toast(`Update available — v${update.version}`, {
    id: TOAST_ID,
    description: update.notes ?? "A new version of Revv is ready to install.",
    duration: Number.POSITIVE_INFINITY,
    icon: Download,
    action: {
      label: "Install",
      onClick: () => {
        void installWithProgress(update);
      },
    },
    cancel: {
      label: "Dismiss",
      onClick: () => {
        rememberDismissal(update.version);
      },
    },
    onDismiss: () => {
      // Fires for the × and for swipe-to-dismiss. The install/error/restart
      // toasts reuse this Sonner slot, and svelte-sonner merges new options
      // over the stored ones — `exactOptionalPropertyTypes` rules out
      // clearing this with an explicit `undefined` — so gate on the card
      // still being the one advertising the update.
      if (notifiedVersion !== update.version) return;
      rememberDismissal(update.version);
    },
  });
}

async function installWithProgress(update: UpdateInfo): Promise<void> {
  notifiedVersion = null;
  toast.loading(`Installing v${update.version}…`, {
    id: TOAST_ID,
    description: "Downloading and applying the update.",
    duration: Number.POSITIVE_INFINITY,
  });
  try {
    await update.install();
  } catch (err) {
    toast.error("Update failed", {
      id: TOAST_ID,
      description: thrownMessage(err),
    });
    return;
  }
  // The bundle is already swapped. If the relaunch fails, or returns without
  // tearing the process down, ask for a restart rather than report a failure.
  try {
    await relaunch();
  } catch (err) {
    console.error("relaunch after update failed", err);
  }
  showRestartFallbackToast();
}

function showRestartFallbackToast(): void {
  toast("Update installed", {
    id: TOAST_ID,
    description: "Restart Revv to finish applying the update.",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Restart now",
      onClick: () => {
        void relaunchNow();
      },
    },
  });
}

async function relaunch(): Promise<void> {
  const { relaunch: doRelaunch } = await import("@tauri-apps/plugin-process");
  await doRelaunch();
}

async function relaunchNow(): Promise<void> {
  try {
    await relaunch();
  } catch (err) {
    toast.error("Failed to restart", {
      id: TOAST_ID,
      description: thrownMessage(err),
    });
  }
}
