// Runtime driver for the in-app updater.
//
// Flow:
//   1. `startUpdater()` is called once from the root layout.
//   2. ~5s later we run the first check (delay is in the caller — see the
//      root layout — so startup network goes to the PR sync first).
//   3. Every hour thereafter we run another check.
//   4. On finding an update, a persistent Sonner toast is shown with
//      Install / Dismiss buttons. The user must click Install to apply.
//
// Every toast this module raises shares one Sonner id. The update toast is
// `duration: Infinity`, so without a shared id the hourly tick would stack a
// fresh "Update available" card on top of the one already sitting on screen,
// once per hour, forever. With the id, a re-notify replaces the card in place
// and the install/error/restart toasts reuse the same slot instead of
// accumulating next to it.
//
// Dismissals are durable. The dismissed version is persisted to
// localStorage, so dismissing v1.2.3 silences v1.2.3 for good instead of
// re-nagging five seconds into the next launch. The memory is keyed on the
// exact version string, so a *newer* release notifies again, and Settings →
// "Check now" bypasses it entirely — an explicit check always answers.
//
// Closing the card with its × counts as a dismissal too. Sonner routes the
// close button and swipe-to-dismiss through `onDismiss` and the Dismiss
// button through `cancel.onClick`; both record the version. Only Install
// leaves the memory alone.

import { UPDATE_STABLE_COOLDOWN_MS } from "@revv/shared";
import Download from "phosphor-svelte/lib/Download";
import { toast } from "svelte-sonner";
import { getIsMaintainer } from "$lib/stores/auth.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { checkForUpdate, type UpdateInfo } from "./client";

const HOURLY_MS = 60 * 60 * 1000;

/** Shared Sonner slot for every updater toast — see the module header. */
const TOAST_ID = "revv-updater";

/** localStorage key holding the last version the user dismissed. */
const DISMISSED_KEY = "revv:updater:dismissed-version";

let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
/**
 * In-memory mirror of {@link DISMISSED_KEY}, so a dismissal still holds for
 * the rest of the session even if the write didn't land.
 */
let dismissedVersion: string | null = null;
/** Version currently advertised by an on-screen toast, if any. */
let notifiedVersion: string | null = null;
let pending: Promise<void> | null = null;

/**
 * Kick off the background update checker. Idempotent. Call this from the root
 * layout's `$effect`.
 */
export function startUpdater(): void {
  if (started) return;
  started = true;
  // First check runs immediately — the caller is expected to delay this
  // call with a setTimeout so it doesn't compete with initial PR sync.
  void runCheck();
  intervalId = setInterval(() => {
    void runCheck();
  }, HOURLY_MS);
}

/** Stops the hourly checker. Useful for tests + hot-reload cleanup. */
export function stopUpdater(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  started = false;
}

/**
 * Run a single update check. Exported so the Settings "Check for updates
 * now" button can reuse the same code path as the background loop. When
 * `manual` is true, callers get an "up to date" toast on the miss path
 * instead of silent no-op.
 *
 * Concurrency: a background tick that lands while another check is running
 * piggybacks on it rather than firing a redundant round-trip. A manual check
 * instead queues behind it, so the Settings button always ends in a toast —
 * previously it dropped the click on the floor whenever the hourly tick
 * happened to be in flight.
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
      // User already told us they don't want this exact version. Stay quiet
      // until a newer one ships or they ask explicitly from Settings.
      return;
    }
    if (!options.manual && update.version === notifiedVersion) {
      // The toast for this version is already on screen from an earlier
      // tick. Re-raising it would only reset its position in the stack.
      return;
    }
    if (!shouldNotify(update, options.manual ?? false)) {
      // Stable channel + non-maintainer + release < 48h old: stay silent
      // on this passive tick. The next hourly check re-evaluates; once the
      // release crosses 48h the gate flips and the toast appears.
      return;
    }
    showUpdateToast(update);
  } catch (err) {
    // Background checks fail silently — the endpoint might be down, the
    // user might be offline, etc. Surface errors only for manual checks.
    console.error("updater check failed", err);
    if (options.manual) {
      toast.error("Update check failed", {
        id: TOAST_ID,
        description: err instanceof Error ? err.message : String(err),
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
  if (getSettings()?.updateChannel === "nightly") return true;
  if (!update.publishedAt) {
    // No pub_date in the manifest — fail open and notify. Better to nag a
    // little early than to indefinitely suppress an update because the CI
    // pipeline forgot to stamp the field.
    return true;
  }
  const publishedMs = Date.parse(update.publishedAt);
  if (Number.isNaN(publishedMs)) return true;
  return Date.now() - publishedMs >= UPDATE_STABLE_COOLDOWN_MS;
}

/** True when the user has dismissed this exact version, now or in a past run. */
function isDismissed(version: string): boolean {
  if (version === dismissedVersion) return true;
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(DISMISSED_KEY) === version;
}

/** Records a dismissal and takes the card off the screen's books. */
function rememberDismissal(version: string): void {
  dismissedVersion = version;
  notifiedVersion = null;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(DISMISSED_KEY, version);
  }
}

function showUpdateToast(update: UpdateInfo): void {
  // Sonner's `duration: Infinity` keeps the toast open until the user
  // explicitly acts. The Install button triggers download+install; Dismiss
  // records the version so this release never nags again.
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
      description: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // The bundle is swapped at this point — the update is applied whether or
  // not we manage to restart. Relaunch to land the user in the new version
  // immediately; if that fails, or returns without tearing the process
  // down, ask them to restart instead of crying "Update failed" over an
  // update that actually succeeded.
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
      description: err instanceof Error ? err.message : String(err),
    });
  }
}
