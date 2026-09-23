// ── Pre-generation sizing ───────────────────────────────────────────────────
//
// How much attention a PR needs, and which model "Auto" would pick for it,
// resolved before any walkthrough exists so the review page can show a risk
// tier on open. The server sizes from the cached diff and caches the answer
// on `(prId, headSha, diffFingerprint)`, shared with the generation path.

import type { WalkthroughSizing } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { getPrById, getSelectedPrId } from "$lib/stores/prs.svelte";
import { authHeaders } from "$lib/utils/session-token";

/**
 * Keyed on `(prId, headSha)`, not `prId` — a pull moves the head SHA, so the
 * old answer stops matching and re-sizes rather than pinning for the branch's life.
 */
let sizings = $state<Record<string, WalkthroughSizing>>({});
/** In-flight de-dupe: mount, settings change and a pull can all ask at once. */
const inFlight = new Map<string, Promise<void>>();
/** Bounded `pending` retries per key, so a never-cached diff can't spin. */
const attempts = new Map<string, number>();

const MAX_PENDING_RETRIES = 6;
const PENDING_RETRY_MS = 2_500;

function cacheKey(prId: string, headSha: string): string {
  return `${prId}@${headSha}`;
}

export function getWalkthroughSizing(
  prId: string | null,
  headSha: string | null,
): WalkthroughSizing | null {
  if (prId === null || headSha === null) return null;
  return sizings[cacheKey(prId, headSha)] ?? null;
}

/**
 * Reactive selected-PR sizing shared by the model and effort selectors.
 * `active` is read inside the effect so a saved Auto sentinel stops polling
 * once the caller's feature gate (e.g. the TypeSafe master switch) is off.
 */
export function sizingForSelectedPr(active: () => boolean) {
  let prId = $derived(getSelectedPrId());
  let headSha = $derived(prId ? (getPrById(prId)?.headSha ?? null) : null);
  let sizing = $derived(getWalkthroughSizing(prId, headSha));
  let pending = $derived.by(
    () =>
      active() &&
      prId !== null &&
      (sizing === null ||
        (sizing.status === "pending" &&
          headSha !== null &&
          (attempts.get(cacheKey(prId, headSha)) ?? 0) < MAX_PENDING_RETRIES)),
  );

  $effect(() => {
    if (!active() || prId === null || headSha === null || sizing !== null) return;
    void fetchWalkthroughSizing(prId, headSha);
  });

  return {
    get sizing(): WalkthroughSizing | null {
      return sizing;
    },
    get pending(): boolean {
      return pending;
    },
  };
}

/**
 * Fetch the preview for a PR at a specific head SHA, de-duped.
 *
 * `pending` means the diff isn't cached yet (normal right after a pull).
 * Retries on a timer since diff-cache-fill has no client-visible event;
 * bounded so a PR whose diff never caches settles instead of polling forever.
 */
export async function fetchWalkthroughSizing(prId: string, headSha: string): Promise<void> {
  const key = cacheKey(prId, headSha);
  const existing = sizings[key];
  if (existing && existing.status !== "pending") return;
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/reviews/${encodeURIComponent(prId)}/walkthrough/sizing`,
        { headers: authHeaders(), credentials: "include" },
      );
      if (!res.ok) return;
      const next = (await res.json()) as WalkthroughSizing;
      sizings = { ...sizings, [key]: next };

      if (next.status === "pending") {
        const tried = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, tried);
        if (tried < MAX_PENDING_RETRIES) {
          setTimeout(() => {
            // Only chase a key still on screen and still unresolved.
            if (sizings[key]?.status === "pending") void fetchWalkthroughSizing(prId, headSha);
          }, PENDING_RETRY_MS);
        }
      } else {
        attempts.delete(key);
      }
    } catch {
      // Best-effort: callers fall back to showing nothing.
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

/**
 * Drop everything. Called on model/agent setting change: routing depends on
 * both, but the server still has the sizing cached, so this re-routes rather
 * than re-paying.
 */
export function resetWalkthroughSizings(): void {
  sizings = {};
  inFlight.clear();
  attempts.clear();
}
