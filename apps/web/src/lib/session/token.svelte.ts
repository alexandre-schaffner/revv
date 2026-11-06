// The bearer token behind every authenticated request. A leaf: it imports
// nothing from stores, so any transport can read it without pulling the
// session's owners into its import graph.

const STORAGE_KEY = "rev_session_token";

let token = $state<string | null>(
  typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null,
);

export function getToken(): string | null {
  return token;
}

export function setToken(next: string): void {
  token = next;
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
}

export function clearToken(): void {
  token = null;
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
}

export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
