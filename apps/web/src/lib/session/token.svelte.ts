// The bearer token behind every authenticated request. A leaf: it imports
// nothing from stores, so any transport can read it without pulling the
// session's owners into its import graph.

import { persisted, STORAGE_KEYS, textCodec } from "$lib/stores/persisted.svelte";

const active = persisted(STORAGE_KEYS.sessionToken, textCodec, null);

export function getToken(): string | null {
  return active.current;
}

export function setToken(next: string): void {
  active.current = next;
}

export function clearToken(): void {
  active.current = null;
}

export function authHeaders(): Record<string, string> {
  const token = active.current;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
