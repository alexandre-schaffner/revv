// "The PR's head moved": bring the diff on screen to the new head, and
// retire what was generated against the old one (walkthrough, chat timeline).

import type { WalkthroughMode } from "@revv/shared";
import { reloadChatForNewHead } from "$lib/chat/turn.svelte";
import { reloadReviewFiles } from "$lib/stores/diff-files.svelte";
import { createResource } from "$lib/stores/resource";
import { invalidateForPull, regenerate } from "$lib/walkthrough/actions";

/** Concurrent pulls of one PR share a request; `loading` drives the pull button's spinner. */
const pulls = createResource<string, true>({
  fetch: async (prId) =>
    (await runPull(prId))
      ? { status: "ok", data: true }
      : { status: "error", error: "Pull failed" },
});

export function getIsPullingCommit(prId: string): boolean {
  return pulls.entry(prId).loading;
}

/**
 * Re-read the PR's files at its current head and supersede the walkthrough,
 * so the user opts into a new one rather than paying for one on every pull.
 * The server's poll has already re-cached the diff at the new head. Resolves
 * true only once the fresh diff is installed.
 */
export async function pullLatestCommit(prId: string): Promise<boolean> {
  const request = await pulls.load(prId, prId);
  return request.status === "ok";
}

async function runPull(prId: string): Promise<boolean> {
  if (!(await reloadReviewFiles(prId))) return false;
  await invalidateForPull(prId);
  reloadChatForNewHead(prId);
  return true;
}

/** Pull the current head, then start the incremental walkthrough the superseded toast offers. */
export async function reviewLatestCommit(prId: string, mode: WalkthroughMode): Promise<void> {
  if (await pullLatestCommit(prId)) await regenerate(prId, mode, "incremental");
}

export function reset(): void {
  pulls.reset();
}
