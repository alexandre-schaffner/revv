// ── suggestions store ─────────────────────────────────────────────────────
//
// Per-PR cache of the right-panel empty-state suggestions. The server
// generates them from PR metadata + the AI walkthrough (when complete) and
// returns three short prompts via `GET /api/prs/:id/suggestions`.
//
// Caching policy:
//   • One fetch per PR id per session unless the user changes the
//     suggestions model / agent, in which case `invalidateSuggestions()` is
//     called from the settings store and the next right-panel open re-fetches.
//   • In-flight requests dedupe so a fast PR switch back-and-forth doesn't
//     hit the endpoint twice.
//   • The server has its own (prId, headSha, model)-keyed cache — the client
//     store is the first line of defense; the server cache absorbs the rest.
//
// On any failure the server itself returns the static fallback prompts, so
// `getSuggestions()` returning `null` strictly means "haven't fetched yet"
// rather than "fetch failed". Consumers can use `FALLBACK_PROMPTS` for the
// pre-fetch render.

import { api } from '$lib/api/client';

export const FALLBACK_PROMPTS: readonly string[] = [
	"What's the riskiest change here?",
	'Summarize the security implications',
	'Suggest a test plan',
];

let suggestionsByPr = $state<Record<string, string[]>>({});
let loadingByPr = $state<Record<string, boolean>>({});

// In-flight requests per PR id. Map (not $state) because we never render
// from this — it's pure de-duplication state.
const inFlight = new Map<string, Promise<void>>();

export function getSuggestions(prId: string): string[] | null {
	return suggestionsByPr[prId] ?? null;
}

export function isSuggestionsLoading(prId: string): boolean {
	return loadingByPr[prId] ?? false;
}

export async function fetchSuggestions(prId: string): Promise<void> {
	if (!prId) return;
	if (suggestionsByPr[prId]) return; // already cached this session
	const existing = inFlight.get(prId);
	if (existing) return existing;

	const promise = (async () => {
		loadingByPr = { ...loadingByPr, [prId]: true };
		try {
			const res = await api.api.prs({ id: prId }).suggestions.get();
			const data = res.data as { suggestions?: unknown } | null;
			const raw = data?.suggestions;
			if (Array.isArray(raw)) {
				const cleaned = raw
					.filter((v): v is string => typeof v === 'string' && v.length > 0)
					.slice(0, 3);
				if (cleaned.length > 0) {
					suggestionsByPr = { ...suggestionsByPr, [prId]: cleaned };
				}
			}
		} catch {
			// Server-side fallback should always succeed; if even the
			// HTTP call fails (network down, server restart) we leave
			// the store empty and let the UI render its own fallback.
		} finally {
			loadingByPr = { ...loadingByPr, [prId]: false };
			inFlight.delete(prId);
		}
	})();

	inFlight.set(prId, promise);
	return promise;
}

/**
 * Drop cached suggestions. With no argument, clears every entry — used when
 * the user changes `aiSuggestionsModel` or `aiAgent` and the previously-
 * fetched prompts no longer reflect the selected model. With a `prId`,
 * clears just that PR (e.g. on commit / head-SHA change in the future).
 */
export function invalidateSuggestions(prId?: string): void {
	if (prId) {
		const { [prId]: _, ...rest } = suggestionsByPr;
		suggestionsByPr = rest;
		const { [prId]: __, ...restLoading } = loadingByPr;
		loadingByPr = restLoading;
		inFlight.delete(prId);
		return;
	}
	suggestionsByPr = {};
	loadingByPr = {};
	inFlight.clear();
}

export function reset(): void {
	invalidateSuggestions();
}
