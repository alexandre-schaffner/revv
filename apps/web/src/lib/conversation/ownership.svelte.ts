// ── Review ownership ────────────────────────────────────────────────────────
//
// The light read behind the files sidebar's review-request line: who asked
// the viewer to review, the CODEOWNERS rules, and the viewer's teams. It is a
// fraction of the conversation query, so it lands with the diff instead of
// seconds after; once the full conversation is loaded, the sidebar reads that
// instead (it carries the same fields and follows the tab's writes).
//
// Also holds what the viewer chose to scope the file tree to. The choice
// carries across PRs: picking a team keeps it picked wherever that team owns
// files, and anywhere else the sidebar falls back to the narrowest group.

import type { PrOwnership } from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import type { RequestState } from "$lib/stores/_types";
import { type Answer, createResource } from "$lib/stores/resource";

/** Reviewers change on GitHub's clock; a fresh read is good for a PR switch and back. */
const FRESH_FOR_MS = 30_000;

const reads = createResource<void, PrOwnership>({
  fetch: async (prId): Promise<Answer<PrOwnership>> => {
    try {
      const data = await call(api.api.prs({ id: prId }).ownership.get(), "Request failed");
      return { status: "ok", data: data.ownership };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : "Request failed" };
    }
  },
  freshForMs: FRESH_FOR_MS,
  keepDataOnError: true,
});

export function loadOwnership(prId: string): void {
  void reads.load(prId, undefined);
}

export function getOwnership(prId: string): RequestState<PrOwnership> {
  return reads.entry(prId).request;
}

/** The read answered, either way: the sidebar can stop holding the tree for it. */
export function isOwnershipSettled(prId: string): boolean {
  const { status } = getOwnership(prId);
  return status === "ok" || status === "error";
}

// The owners (as written in CODEOWNERS) the viewer picked; null until they pick.
let pickedScope = $state<readonly string[] | null>(null);
// Hide the files outside the scope. Kept across PRs: it's how the viewer reads.
let onlyScope = $state(false);

export function getPickedScope(): readonly string[] | null {
  return pickedScope;
}

/** Null goes back to the default: the viewer's narrowest group. */
export function setPickedScope(owners: readonly string[] | null): void {
  pickedScope = owners;
}

export function getOnlyScope(): boolean {
  return onlyScope;
}

export function setOnlyScope(value: boolean): void {
  onlyScope = value;
}

export function reset(): void {
  reads.reset();
  pickedScope = null;
  onlyScope = false;
}
