import type { RuntimeHealth } from "@revv/shared";
import { toast } from "svelte-sonner";
import { getCommitHash } from "./client";
import { compareServiceBuild } from "./service-build";

/**
 * Warn when the server answering the app runs a different build.
 *
 * The app ships its server compiled into the bundle and starts it itself, so
 * the two normally match. A mismatch means a server the app doesn't own is on
 * its port, such as a LaunchAgent left behind by Revv 0.32.2 or earlier.
 * Without this, the UI would silently run against code it wasn't built for.
 * Dev builds skip it: `make dev` runs both from one tree.
 */
export function warnIfServiceOutOfDate(health: RuntimeHealth): void {
  if (import.meta.env.DEV) return;
  const appCommit = getCommitHash();
  const build = compareServiceBuild(appCommit, health.commit);
  if (build.kind !== "mismatch") return;

  const service = build.serviceCommit ?? "an older build";
  toast.warning("Revv is connected to a different server build", {
    id: "service-build-mismatch",
    description:
      `The app is on ${appCommit}, but the server that runs reviews and chat is on ${service}. ` +
      `Quit Revv from the menu bar icon and open it again.`,
    duration: Number.POSITIVE_INFINITY,
  });
}
