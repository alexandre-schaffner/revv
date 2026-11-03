import { toast } from "svelte-sonner";
import type { RuntimeHealth } from "$lib/api/runtime";
import { compareServiceBuild } from "$lib/api/service-build";
import { getCommitHash } from "./client";

const UPDATE_COMMAND = "revv update";

/**
 * Warn when the background server runs a different build than the app.
 *
 * In-app updates replace only the `.app`; the server keeps running from the
 * source checkout until `revv update` moves it. Without this, server-side
 * fixes look shipped (Settings shows the app's new commit) while the old
 * server keeps failing. Dev builds skip it: `make dev` runs both from one tree.
 */
export function warnIfServiceOutOfDate(health: RuntimeHealth): void {
  if (import.meta.env.DEV) return;
  const appCommit = getCommitHash();
  const build = compareServiceBuild(appCommit, health.commit);
  if (build.kind !== "mismatch") return;

  const service = build.serviceCommit ?? "an older build";
  toast.warning("Revv's background service is out of date", {
    id: "service-build-mismatch",
    description:
      `The app is on ${appCommit}, but the service that runs reviews and chat is on ${service}. ` +
      `In-app updates don't refresh the service yet, so recent fixes may be missing. ` +
      `Run "${UPDATE_COMMAND}" in Terminal to bring both to the same build.`,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Copy command",
      onClick: () => {
        void navigator.clipboard.writeText(UPDATE_COMMAND).catch(() => {});
      },
    },
  });
}
