// ── Auto-model preview ──────────────────────────────────────────────────────
//
// What "Auto" will pick for a PR, resolved before generation starts so the
// model selector can name it instead of showing a blank.
//
// The server sizes the PR from its cached diff and caches the answer on
// `(prId, headSha)`, sharing it with the generation path — so asking here is
// the same TypeSafe call moved earlier, not an extra one.

import type { RiskLevel } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/utils/session-token";

export type ModelPreview =
  | { status: "off" }
  | { status: "pending" }
  | { status: "ready"; model: string | null; riskLevel: RiskLevel };

/**
 * Keyed on `(prId, headSha)`, not `prId`.
 *
 * That is what makes a pull re-size: new commits move the PR's head SHA, the
 * key changes, the old answer stops matching and the selector asks again.
 * Keying on the PR alone would pin the first sizing for the life of the
 * branch, which is exactly wrong for a judgment about the diff.
 */
let previews = $state<Record<string, ModelPreview>>({});
/** In-flight de-dupe: mount, settings change and a pull can all ask at once. */
const inFlight = new Map<string, Promise<void>>();
/** Bounded `pending` retries per key, so a never-cached diff can't spin. */
const attempts = new Map<string, number>();

const MAX_PENDING_RETRIES = 6;
const PENDING_RETRY_MS = 2_500;

function cacheKey(prId: string, headSha: string): string {
  return `${prId}@${headSha}`;
}

export function getModelPreview(prId: string | null, headSha: string | null): ModelPreview | null {
  if (prId === null || headSha === null) return null;
  return previews[cacheKey(prId, headSha)] ?? null;
}

/**
 * Fetch the preview for a PR at a specific head SHA, de-duped.
 *
 * `pending` means the server has no cached diff to size yet — normal right
 * after a pull, while the poller re-fetches. It retries on a timer rather
 * than waiting for a signal, because the thing it is waiting for (the diff
 * cache filling) has no client-visible event. Bounded so a PR whose diff
 * never caches settles instead of polling forever.
 */
export async function fetchModelPreview(prId: string, headSha: string): Promise<void> {
  const key = cacheKey(prId, headSha);
  const existing = previews[key];
  if (existing && existing.status !== "pending") return;
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/reviews/${encodeURIComponent(prId)}/walkthrough/model-preview`,
        { headers: authHeaders(), credentials: "include" },
      );
      if (!res.ok) return;
      const next = (await res.json()) as ModelPreview;
      previews = { ...previews, [key]: next };

      if (next.status === "pending") {
        const tried = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, tried);
        if (tried < MAX_PENDING_RETRIES) {
          setTimeout(() => {
            // Only chase a key still on screen and still unresolved.
            if (previews[key]?.status === "pending") void fetchModelPreview(prId, headSha);
          }, PENDING_RETRY_MS);
        }
      } else {
        attempts.delete(key);
      }
    } catch {
      // Best-effort: the selector falls back to a bare "Auto".
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

/**
 * Drop everything. Called when the model or agent setting changes, since the
 * routing — though not the underlying sizing — depends on both. The server
 * still has the sizing cached, so this re-routes rather than re-paying.
 */
export function resetModelPreviews(): void {
  previews = {};
  inFlight.clear();
  attempts.clear();
}
