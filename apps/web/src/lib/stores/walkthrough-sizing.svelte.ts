// ── Pre-generation sizing ───────────────────────────────────────────────────
//
// How much attention a PR needs, and which model "Auto" would pick for it,
// resolved before any walkthrough exists so the review page can show a risk
// tier on open. The server sizes from the cached diff and caches the answer
// on `(prId, headSha, diffFingerprint)`, shared with the generation path.

import type { WalkthroughSizing } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/session/token.svelte";
import { getPrById, getSelectedPrId } from "$lib/stores/prs.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { createResource } from "./resource";

/**
 * Keyed on everything the answer depends on: `(prId, headSha)`, since a pull
 * moves the head and the old answer stops matching, and the agent, model,
 * effort and TypeSafe switch it is routed against (the server has each one
 * cached, so a settings change re-routes rather than re-pays).
 * `pending` means the diff isn't cached yet (normal right after a pull); the
 * diff-cache fill has no client-visible event, so it is asked again on a timer.
 * An HTTP error (auth, unknown PR) is not pending: it is recorded, and callers
 * show nothing.
 */
const sizings = createResource<{ prId: string }, WalkthroughSizing>({
  freshForMs: Number.POSITIVE_INFINITY,
  retryDelaysMs: [2_500, 2_500, 2_500, 2_500, 2_500],
  fetch: async (_key, { prId }) => {
    const res = await fetch(
      `${API_BASE_URL}/api/reviews/${encodeURIComponent(prId)}/walkthrough/sizing`,
      { headers: authHeaders(), credentials: "include" },
    );
    if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
    const data = (await res.json()) as WalkthroughSizing;
    return data.status === "pending" ? { status: "pending", data } : { status: "ok", data };
  },
});

function cacheKey(prId: string, headSha: string): string {
  const s = getSettings();
  return [prId, headSha, s?.aiAgent, s?.aiModel, s?.aiThinkingEffort, s?.jev.enabled].join("|");
}

export function getWalkthroughSizing(
  prId: string | null,
  headSha: string | null,
): WalkthroughSizing | null {
  if (prId === null || headSha === null) return null;
  return sizings.data(cacheKey(prId, headSha));
}

/** Fetch the preview for a PR at a specific head SHA, de-duped and cached. */
export function fetchWalkthroughSizing(prId: string, headSha: string): Promise<void> {
  return sizings.load(cacheKey(prId, headSha), { prId }).then(() => undefined);
}

function selectedPrHead(): { prId: string; headSha: string } | null {
  const prId = getSelectedPrId();
  const headSha = prId ? (getPrById(prId)?.headSha ?? null) : null;
  return prId && headSha ? { prId, headSha } : null;
}

/**
 * Ask for the selected PR's sizing unless it was already asked: an error or a
 * gave-up answer stands until the head moves. Call from an effect gated on
 * wanting it.
 */
export function ensureSelectedPrSizing(): void {
  const head = selectedPrHead();
  if (!head) return;
  if (sizings.entry(cacheKey(head.prId, head.headSha)).request.status !== "idle") return;
  void fetchWalkthroughSizing(head.prId, head.headSha);
}

/**
 * The selected PR's sizing, and whether one is still outstanding while
 * `active` (the caller's feature gate, e.g. a saved Auto sentinel with the
 * TypeSafe master switch on).
 */
export function getSelectedPrSizing(active: boolean): {
  sizing: WalkthroughSizing | null;
  pending: boolean;
} {
  const head = selectedPrHead();
  if (!head) return { sizing: null, pending: false };
  const entry = sizings.entry(cacheKey(head.prId, head.headSha));
  const sizing = entry.request.status === "ok" ? entry.request.data : null;
  const pending =
    active &&
    entry.request.status !== "error" &&
    (sizing === null || (sizing.status === "pending" && !entry.gaveUp));
  return { sizing, pending };
}

export function reset(): void {
  sizings.reset();
}
