// How much attention a PR needs, and which model "Auto" would pick for it,
// resolved before any walkthrough exists so the review page can show a risk
// tier on open. The server sizes from the cached diff and caches the answer
// on `(prId, headSha, diffFingerprint)`, shared with the generation path.

import type { RiskLevel, WalkthroughSizing } from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { DIFF_FILL_WAIT_MS } from "$lib/review/diff-cache";
import { getPrById } from "$lib/stores/prs.svelte";
import { createResource } from "$lib/stores/resource";
import { getSettings } from "$lib/stores/settings.svelte";
import { getRiskLevel } from "./store.svelte";

interface SizingAsk {
  readonly prId: string;
  readonly headSha: string;
}

/**
 * Keyed on everything the answer depends on: `(prId, headSha)`, since a pull
 * moves the head and the old answer stops matching, and the agent, model,
 * effort and TypeSafe switch it is routed against (the server has each one
 * cached, so a settings change re-routes rather than re-pays).
 * `pending` means the diff isn't cached yet (normal right after a pull): the
 * ask waits for `diff:cached`. An HTTP error (auth, unknown PR) is not
 * pending: it is recorded, and callers show nothing.
 */
const sizings = createResource<SizingAsk, WalkthroughSizing>({
  freshForMs: Number.POSITIVE_INFINITY,
  waitForSignalMs: DIFF_FILL_WAIT_MS,
  fetch: async (_key, { prId }) => {
    const data = await call(
      api.api.reviews({ id: prId }).walkthrough.sizing.get(),
      "Sizing failed",
    );
    return data.status === "pending" ? { status: "pending", data } : { status: "ok", data };
  },
});

function cacheKey(prId: string, headSha: string): string {
  const s = getSettings();
  return [prId, headSha, s.aiAgent, s.aiModel, s.aiThinkingEffort, s.jev.enabled].join("|");
}

function currentHead(prId: string | null): SizingAsk | null {
  const headSha = prId ? (getPrById(prId)?.headSha ?? null) : null;
  return prId && headSha ? { prId, headSha } : null;
}

/**
 * Ask for the PR's sizing at its current head unless it was already asked: an
 * error or a gave-up answer stands until the head moves. Call from an effect
 * gated on wanting it.
 */
export function ensurePrSizing(prId: string | null): void {
  const head = currentHead(prId);
  if (!head) return;
  if (sizings.entry(cacheKey(head.prId, head.headSha)).request.status !== "idle") return;
  void sizings.load(cacheKey(head.prId, head.headSha), head);
}

/**
 * The PR's sizing at its current head, and whether one is still outstanding
 * while `active` (the caller's feature gate, e.g. a saved Auto sentinel with
 * the TypeSafe master switch on).
 */
export function getPrSizing(
  prId: string | null,
  active: boolean,
): { sizing: WalkthroughSizing | null; pending: boolean } {
  const head = currentHead(prId);
  if (!head) return { sizing: null, pending: false };
  const entry = sizings.entry(cacheKey(head.prId, head.headSha));
  const sizing = entry.request.status === "ok" ? entry.request.data : null;
  const pending =
    active &&
    entry.request.status !== "error" &&
    (sizing === null || (sizing.status === "pending" && !entry.gaveUp));
  return { sizing, pending };
}

/**
 * How much attention the PR needs: the tier its walkthrough was written at,
 * else the one sized from the diff before any review ran. `fromReview` says
 * which.
 */
export function getPrRiskTier(prId: string): { level: RiskLevel; fromReview: boolean } | null {
  const reviewed = getRiskLevel(prId);
  if (reviewed !== null) return { level: reviewed, fromReview: true };
  const { sizing } = getPrSizing(prId, false);
  return sizing?.status === "ready" && sizing.riskLevel !== null
    ? { level: sizing.riskLevel, fromReview: false }
    : null;
}

/** Size the PR from its diff unless a walkthrough already set its tier. */
export function ensurePrRiskTier(prId: string | null): void {
  if (prId !== null && getRiskLevel(prId) === null) ensurePrSizing(prId);
}

/** The diff a `pending` sizing was waiting for is cached: ask again. */
export function onDiffCached(data: { prId: string; headSha: string }): void {
  sizings.refreshWaiting((_key, ask) => ask.prId === data.prId && ask.headSha === data.headSha);
}

export function reset(): void {
  sizings.reset();
}
