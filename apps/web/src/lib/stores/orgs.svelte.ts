import type { Org } from "@revv/shared";
import { api } from "$lib/api/client";

let currentUserId = $state<string | null>(null);

function storageKey(): string {
  return currentUserId ? `rev_active_org_${currentUserId}` : "rev_active_org";
}

let availableOrgs = $state<Org[]>([]);
let activeOrg = $state<string | null>(
  typeof localStorage !== "undefined" ? localStorage.getItem(storageKey()) : null,
);

export function initForUser(userId: string): void {
  // Another user's orgs are no answer for this one.
  if (userId !== currentUserId) orgsLoadedAt = 0;
  currentUserId = userId;
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey()) : null;
  activeOrg = stored;
}

/** Orgs barely move; the session boot and the top bar both ask on every load. */
const ORGS_FRESH_FOR_MS = 5 * 60 * 1000;
let orgsInflight: Promise<void> | null = null;
let orgsLoadedAt = 0;

/** Read the user's orgs, unless a fresh read is on hand; concurrent calls share one. */
export function fetchOrgs(): Promise<void> {
  if (Date.now() - orgsLoadedAt < ORGS_FRESH_FOR_MS) return Promise.resolve();
  orgsInflight ??= readOrgs().finally(() => {
    orgsInflight = null;
  });
  return orgsInflight;
}

async function readOrgs(): Promise<void> {
  try {
    const { data } = await api.api.user.orgs.get();
    if (data && "orgs" in data) {
      orgsLoadedAt = Date.now();
      availableOrgs = data.orgs as Org[];
      const valid = activeOrg && availableOrgs.some((o) => o.login === activeOrg);
      if (!valid) {
        // Auto-select the first org if none is stored or the stored one is gone
        setActiveOrg(availableOrgs[0]?.login ?? null);
      }
    }
  } catch {
    // Silent degrade — same posture as /api/user/identity failures.
  }
}

function setActiveOrg(login: string | null): void {
  activeOrg = login;
  if (typeof localStorage !== "undefined") {
    if (login) localStorage.setItem(storageKey(), login);
    else localStorage.removeItem(storageKey());
  }
}

export function reset(): void {
  orgsLoadedAt = 0;
  availableOrgs = [];
  activeOrg = null;
  currentUserId = null;
  // Intentionally NOT removing localStorage key — per-user org selection persists across account switches
}
