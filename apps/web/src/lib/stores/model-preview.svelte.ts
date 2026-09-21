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

let previews = $state<Record<string, ModelPreview>>({});
/** In-flight de-dupe: mount + settings change can both ask at once. */
const inFlight = new Map<string, Promise<void>>();

export function getModelPreview(prId: string | null): ModelPreview | null {
  if (prId === null) return null;
  return previews[prId] ?? null;
}

/**
 * Fetch the preview for a PR, de-duped.
 *
 * `pending` is not cached as a final answer — it means "the diff hasn't
 * landed yet", so a later call (once the review page has its files) is
 * expected to resolve. Everything else sticks until `resetModelPreviews`.
 */
export async function fetchModelPreview(prId: string): Promise<void> {
  const existing = previews[prId];
  if (existing && existing.status !== "pending") return;
  const running = inFlight.get(prId);
  if (running) return running;

  const task = (async () => {
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/reviews/${encodeURIComponent(prId)}/walkthrough/model-preview`,
        { headers: authHeaders(), credentials: "include" },
      );
      if (!res.ok) return;
      previews = { ...previews, [prId]: (await res.json()) as ModelPreview };
    } catch {
      // Best-effort: the selector falls back to a bare "Auto".
    } finally {
      inFlight.delete(prId);
    }
  })();
  inFlight.set(prId, task);
  return task;
}

/**
 * Drop everything. Called when the model or agent setting changes, since the
 * routing — though not the underlying sizing — depends on both.
 */
export function resetModelPreviews(): void {
  previews = {};
  inFlight.clear();
}
