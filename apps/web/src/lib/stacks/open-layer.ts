import { buildPullRequestDeepLink, type PrStackEntry } from "@revv/shared";
import { setNavigationIntent } from "$lib/stores/navigation-intent.svelte";
import { openPrDeepLink } from "$lib/stores/pr-deep-link.svelte";
import { getPrById, getPullRequests, getRepositories, selectPr } from "$lib/stores/prs.svelte";
import { getLayer } from "$lib/stores/stacks.svelte";

type Layer = Pick<PrStackEntry, "number"> & {
  readonly prId?: string | null;
  readonly position?: number;
};

export function openStackLayer(fromPrId: string, layer: Layer): void {
  const from = getPrById(fromPrId);
  const here = getLayer(fromPrId)?.position ?? from?.stack?.position;
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
