import { Effect } from "effect";
import { RepoNotAccessibleError } from "../domain/errors";
import { clientIdIsGitHubApp, resolveClientId } from "../github-oauth";
import { GitHubGateway } from "./github/gateway";
import type { AppInstallation } from "./github/repos";
import type { GitHubClient } from "./github/transport";
import { SettingsService } from "./Settings";

/**
 * Explain an add-repo 404.
 *
 * `installations` is the GitHub App's installation list, or `null` when the
 * host signs in through a classic OAuth App (or the list couldn't be read).
 * A GitHub App token only sees repos the app is installed on, so on that path
 * the usual cause isn't a typo but an org the app was never installed on, or
 * an installation limited to a few selected repositories.
 */
export function explainRepoNotFound(
  fullName: string,
  host: string,
  installations: readonly AppInstallation[] | null,
): RepoNotAccessibleError {
  const [owner = fullName, name = fullName] = fullName.split("/");
  const notFound = new RepoNotAccessibleError({
    message: `${fullName} wasn't found on ${host}`,
    detail: "Check the owner and name, and that your GitHub account can open it.",
    action: null,
  });
  if (installations === null) return notFound;

  const installation = installations.find(
    (i) => i.accountLogin.toLowerCase() === owner.toLowerCase(),
  );
  if (installation?.repositorySelection === "all") return notFound;
  if (installation) {
    return new RepoNotAccessibleError({
      message: `Revv can't see ${fullName} yet`,
      detail:
        `The GitHub App you signed in with is installed on ${owner} for selected repositories ` +
        `only. Add ${name} to its repository access (an ${owner} owner may need to), then try again.`,
      action: { label: "Grant access", url: installation.htmlUrl },
    });
  }

  const appSlug = installations[0]?.appSlug;
  return new RepoNotAccessibleError({
    message: `The GitHub App isn't installed on ${owner}`,
    detail:
      "Revv only sees repositories where the GitHub App you signed in with is installed. " +
      `Install it on ${owner} (or ask an ${owner} owner to), then try again.`,
    action: appSlug
      ? { label: "Install app", url: `https://${host}/apps/${appSlug}/installations/new` }
      : null,
  });
}

/**
 * Diagnose why `fullName` 404'd for this client. Never fails: a lookup that
 * can't complete degrades to the plain "not found" explanation.
 */
export const diagnoseRepoNotFound = (
  fullName: string,
  client: GitHubClient,
): Effect.Effect<RepoNotAccessibleError, never, GitHubGateway | SettingsService> =>
  Effect.gen(function* () {
    const github = yield* GitHubGateway;
    const settings = yield* Effect.flatMap(SettingsService, (s) => s.getSettings());
    const signsInWithApp = yield* Effect.try(() =>
      clientIdIsGitHubApp(resolveClientId(client.host, settings)),
    ).pipe(Effect.orElseSucceed(() => false));
    const installations = signsInWithApp
      ? yield* github.repos.appInstallationsForUser(client).pipe(Effect.orElseSucceed(() => null))
      : null;
    return explainRepoNotFound(fullName, client.host, installations);
  });
