// ── Opening another layer of the stack ─────────────────────────────────────
//
// Every walkthrough-side stack surface (the overview's layer list, the handoff
// card, the restack banner, a `#N (layer k)` citation) moves the reader the
// same way: a layer Revv tracks opens directly, anything else (a merged base,
// a layer the poll hasn't reached) goes through the deep-link resolver, which
// fetches it from GitHub and opens it here. Never leaves the app.

import { buildPullRequestDeepLink, type PrStackEntry } from "@revv/shared";
import { setNavigationIntent } from "$lib/stores/navigation-intent.svelte";
import { openPrDeepLink } from "$lib/stores/pr-deep-link.svelte";
import { getPrById, getPullRequests, getRepositories, selectPr } from "$lib/stores/prs.svelte";

/** A stack member, with Revv's id for it when the stack read knew one. */
type Layer = Pick<PrStackEntry, "number"> & {
  readonly prId?: string | null;
  readonly position?: number;
};

/**
 * Open `layer`, a member of the stack `fromPrId` sits in. The page slides
 * the way the stack goes: up toward the top layer, down toward the base.
 */
export function openStackLayer(fromPrId: string, layer: Layer): void {
  const from = getPrById(fromPrId);
  const here = from?.stack?.position;
  if (here !== undefined && layer.position !== undefined && layer.position !== here) {
    setNavigationIntent(layer.position > here ? "up" : "down");
  }
  if (layer.prId) {
    void selectPr(layer.prId);
    return;
  }
  if (!from) return;
  const tracked = getPullRequests().find(
    (p) => p.repositoryId === from.repositoryId && p.externalId === layer.number,
  );
  if (tracked) {
    void selectPr(tracked.id);
    return;
  }
  const repository = getRepositories().find((r) => r.id === from.repositoryId);
  if (!repository) return;
  void openPrDeepLink(
    buildPullRequestDeepLink({
      githubHost: repository.githubHost,
      repositoryFullName: repository.fullName,
      number: layer.number,
    }),
  );
}
