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
// Dismissals are session-scoped: we store the dismissed version in a
// module-level variable so the toast doesn't reappear on the next hourly
// tick, but a full app restart resets it. That's intentional — if the user
// dismisses an update and then leaves the app running for a week, the next
// launch should offer it again.

import { UPDATE_STABLE_COOLDOWN_MS } from "@revv/shared";
import Download from "phosphor-svelte/lib/Download";
import { toast } from "svelte-sonner";
import { getIsMaintainer } from "$lib/stores/auth.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { isTauri } from "$lib/utils/platform";
import { checkForUpdate, type UpdateInfo } from "./client";

const HOURLY_MS = 60 * 60 * 1000;

let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let dismissedVersion: string | null = null;
let inFlight = false;

/**
 * Kick off the background update checker. Idempotent and a no-op outside
 * Tauri. Call this from the root layout's `$effect`.
 */
export function startUpdater(): void {
  if (started || !isTauri()) return;
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
 */
export async function runCheck(options: { manual?: boolean } = {}): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const update = await checkForUpdate();
    if (!update) {
      if (options.manual) {
        toast.success("You're up to date", {
          description: "No new version available.",
        });
      }
      return;
    }
    if (!options.manual && update.version === dismissedVersion) {
      // User already dismissed this version during this session; don't
      // re-toast on every hourly tick. The flag resets on app restart.
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
        description: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    inFlight = false;
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

function showUpdateToast(update: UpdateInfo): void {
  // Sonner's `duration: Infinity` keeps the toast open until the user
  // explicitly acts. The Install button triggers download+install; Dismiss
  // records the version so we don't re-nag until the next launch.
  toast(`Update available — v${update.version}`, {
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
        dismissedVersion = update.version;
      },
    },
  });
}

async function installWithProgress(update: UpdateInfo): Promise<void> {
  const id = toast.loading(`Installing v${update.version}…`, {
    description: "Downloading and applying the update.",
    duration: Number.POSITIVE_INFINITY,
  });
  try {
    await update.install();
    // As with auto-install: if relaunch() returned without tearing the
    // process down, prompt the user to restart. Most of the time we
    // never reach this branch.
    toast.dismiss(id);
    showRestartFallbackToast();
  } catch (err) {
    toast.dismiss(id);
    toast.error("Update failed", {
      description: err instanceof Error ? err.message : String(err),
    });
  }
}

function showRestartFallbackToast(): void {
  toast("Update installed", {
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

async function relaunchNow(): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    toast.error("Failed to restart", {
      description: err instanceof Error ? err.message : String(err),
    });
  }
}
