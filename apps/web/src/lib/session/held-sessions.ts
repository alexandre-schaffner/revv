// Every account this machine's windows signed in to, with its session token.
// The server answers nothing to a signed-out caller, so a signed-out window
// can only offer the accounts whose tokens it still holds.

import { jsonCodec, readStored, STORAGE_KEYS, writeStored } from "$lib/stores/persisted.svelte";

/** An account a window signed in to: its session token and how to show it. */
export interface HeldSession {
  readonly userId: string;
  readonly token: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

function isHeldSession(value: unknown): value is HeldSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === "string" &&
    typeof v.token === "string" &&
    typeof v.name === "string" &&
    typeof v.email === "string" &&
    (v.image === null || typeof v.image === "string")
  );
}

const heldCodec = jsonCodec<readonly HeldSession[]>((value) =>
  Array.isArray(value) ? value.filter(isHeldSession) : undefined,
);

// Read from storage on every call, never cached: another window may have
// signed in or out since.
export function getHeldSessions(): readonly HeldSession[] {
  return readStored(STORAGE_KEYS.heldSessions, heldCodec, []);
}

function writeHeld(next: readonly HeldSession[]): void {
  writeStored(STORAGE_KEYS.heldSessions, heldCodec, next);
}

export function heldToken(userId: string): string | null {
  return getHeldSessions().find((s) => s.userId === userId)?.token ?? null;
}

/** Remember `session` as its user's, replacing the one held before. */
export function holdSession(session: HeldSession): void {
  writeHeld([...getHeldSessions().filter((s) => s.userId !== session.userId), session]);
}

/** Forget a session the server no longer honours, by its user or its token. */
export function releaseSession(
  match: { readonly userId: string } | { readonly token: string },
): void {
  writeHeld(
    getHeldSessions().filter((s) =>
      "userId" in match ? s.userId !== match.userId : s.token !== match.token,
    ),
  );
}
