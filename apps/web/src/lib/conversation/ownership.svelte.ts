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
import { getPrById } from "$lib/stores/prs.svelte";
import { type Answer, createResource } from "$lib/stores/resource";

/** Reviewers change on GitHub's clock; a fresh read is good for a PR switch and back. */
const FRESH_FOR_MS = 30_000;

// Repos whose last read had no CODEOWNERS: the sidebar needn't hold their
// trees for a line that won't come. Plain Set; only gates a wait.
const withoutCodeowners = new Set<string>();

const reads = createResource<void, PrOwnership>({
  fetch: async (prId): Promise<Answer<PrOwnership>> => {
    try {
      const data = await call(api.api.prs({ id: prId }).ownership.get(), "Request failed");
      const repoId = getPrById(prId)?.repositoryId;
      if (repoId) {
        if (data.ownership.codeowners === null) withoutCodeowners.add(repoId);
        else withoutCodeowners.delete(repoId);
      }
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

/** The last read of a PR in this repo found no CODEOWNERS. */
export function repoLacksCodeowners(repoId: string): boolean {
  return withoutCodeowners.has(repoId);
}

/** The read answered, either way: the sidebar can stop holding the tree for it. */
export function isOwnershipSettled(prId: string): boolean {
  const { status } = getOwnership(prId);
  return status === "ok" || status === "error";
}

/**
 * The owners (as written in CODEOWNERS) the viewer picked. A pick naming
 * owners carries to every PR where they own files; unchecking everything
 * empties the scope on that PR only (`prId`), not on the next one.
 */
export interface ScopePick {
  readonly owners: readonly string[];
  readonly prId: string;
}

// Null until the viewer picks: the default (their narrowest group) applies.
let pickedScope = $state<ScopePick | null>(null);
// Hide the files outside the scope. Kept across PRs: it's how the viewer reads.
let onlyScope = $state(false);

export function getPickedScope(): ScopePick | null {
  return pickedScope;
}

/** Null goes back to the default: the viewer's narrowest group. */
export function setPickedScope(pick: ScopePick | null): void {
  pickedScope = pick;
}

export function getOnlyScope(): boolean {
  return onlyScope;
}

export function setOnlyScope(value: boolean): void {
  onlyScope = value;
}

export function reset(): void {
  reads.reset();
  withoutCodeowners.clear();
  pickedScope = null;
  onlyScope = false;
}
