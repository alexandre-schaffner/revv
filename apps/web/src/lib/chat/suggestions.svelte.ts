// ── Chat empty-state suggestions ──────────────────────────────────────────
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
// rather than "fetch failed". Consumers render `CHAT_SUGGESTION_FALLBACKS`
// meanwhile.

import { untrack } from "svelte";
import { api } from "$lib/api/client";
import { createResource } from "$lib/stores/resource";
import { getSettings } from "$lib/stores/settings.svelte";

const suggestions = createResource<string, string[]>({
  freshForMs: Number.POSITIVE_INFINITY,
  fetch: async (_key, prId) => {
    const { data } = await api.api.prs({ id: prId }).suggestions.get();
    // An empty answer is not cached: the UI keeps the fallback.
    return data && data.suggestions.length > 0
      ? { status: "ok", data: data.suggestions }
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

/** Ask for the prompts unless they are cached. Tracks only the key's inputs. */
export function fetchSuggestions(prId: string): void {
  const key = cacheKey(prId);
  untrack(() => void suggestions.load(key, prId));
}

export function reset(): void {
  suggestions.reset();
}
