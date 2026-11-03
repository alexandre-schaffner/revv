/**
 * How the server's build compares to the app's. The in-app updater replaces
 * only the `.app`; the server runs from a separate source checkout, which the
 * desktop shell moves to the app's commit on launch when it safely can.
 */
export type ServiceBuild =
  | { kind: "match" }
  | { kind: "unknown" }
  | { kind: "mismatch"; serviceCommit: string | null };

const SHORT_SHA_LENGTH = 7;

/**
 * @param serviceCommit `/api/health`'s `commit`: `undefined` when the server
 * predates the field, `null` when it couldn't read its own commit.
 */
export function compareServiceBuild(
  appCommit: string,
  serviceCommit: string | null | undefined,
): ServiceBuild {
  // A server that doesn't report a commit at all predates this check, so it
  // is older than any app that performs it.
  if (serviceCommit === undefined) return { kind: "mismatch", serviceCommit: null };
  if (serviceCommit === null || appCommit === "unknown") return { kind: "unknown" };
  // Either side may be abbreviated; compare on the shorter one.
  const [shorter, longer] =
    appCommit.length <= serviceCommit.length
      ? [appCommit, serviceCommit]
      : [serviceCommit, appCommit];
  if (shorter.length >= SHORT_SHA_LENGTH && longer.startsWith(shorter)) return { kind: "match" };
  return { kind: "mismatch", serviceCommit: serviceCommit.slice(0, SHORT_SHA_LENGTH) };
}
