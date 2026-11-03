import { toast } from "svelte-sonner";
import type { RuntimeHealth } from "$lib/api/runtime";
import { compareServiceBuild } from "$lib/api/service-build";
import { getCommitHash } from "./client";

const UPDATE_COMMAND = "revv update";

/**
 * Warn when the background server runs a different build than the app.
 *
 * In-app updates replace only the `.app`; on launch the desktop shell moves
 * the installer-managed server checkout to the app's commit (see
 * `server_source.rs`). It leaves the checkout alone when it lives elsewhere or
 * has local edits, and gives up on fetch or install errors, so this is the
 * backstop: without it, server-side fixes look shipped while an old server
 * keeps failing. Dev builds skip it: `make dev` runs both from one tree.
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
      `The app is on ${appCommit}, but the service that runs reviews and chat is on ${service}, ` +
      `so recent fixes may be missing. Revv couldn't update it on launch; the reason is in ` +
      `~/Library/Logs/Revv/server.err.log. Run "${UPDATE_COMMAND}" in Terminal to bring both ` +
      `to the same build.`,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Copy command",
      onClick: () => {
        void navigator.clipboard.writeText(UPDATE_COMMAND).catch(() => {});
      },
    },
  });
}
