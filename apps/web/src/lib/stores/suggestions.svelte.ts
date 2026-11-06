// ── suggestions store ─────────────────────────────────────────────────────
//
// Per-PR cache of the right-panel empty-state suggestions. The server
// generates them from PR metadata + the AI walkthrough (when complete) and
// returns three short prompts via `GET /api/prs/:id/suggestions`.
//
// Cached for the session per `(prId, agent, suggestions model)`, so picking
// another model or agent asks again on the next right-panel open; the server
// has its own `(prId, headSha, model)` cache behind it.
//
// On any failure the server itself returns the static fallback prompts, so
// `getSuggestions()` returning `null` strictly means "haven't fetched yet"
// rather than "fetch failed". Consumers can use `FALLBACK_PROMPTS` for the
// pre-fetch render.

import { api } from "$lib/api/client";
import { getSettings } from "$lib/stores/settings.svelte";
import { createResource } from "./resource";

export const FALLBACK_PROMPTS: readonly string[] = [
  "What's the riskiest change here?",
  "Summarize the security implications",
  "Suggest a test plan",
];

const suggestions = createResource<string, string[]>({
  freshForMs: Number.POSITIVE_INFINITY,
  fetch: async (_key, prId) => {
    const res = await api.api.prs({ id: prId }).suggestions.get();
    const data = res.data as { suggestions?: unknown } | null;
    const raw = data?.suggestions;
    const cleaned = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 3)
      : [];
    // An empty answer is not cached: the UI keeps its own fallback.
    return cleaned.length > 0
      ? { status: "ok", data: cleaned }
      : { status: "error", error: "No suggestions" };
  },
});

function cacheKey(prId: string): string {
  const s = getSettings();
  return `${prId}|${s.aiAgent}|${s.aiSuggestionsModel}`;
}

export function getSuggestions(prId: string): string[] | null {
  return suggestions.data(cacheKey(prId));
}

export function isSuggestionsLoading(prId: string): boolean {
  return suggestions.entry(cacheKey(prId)).loading;
}

export async function fetchSuggestions(prId: string): Promise<void> {
  if (!prId) return;
  await suggestions.load(cacheKey(prId), prId);
}

export function reset(): void {
  suggestions.reset();
}
