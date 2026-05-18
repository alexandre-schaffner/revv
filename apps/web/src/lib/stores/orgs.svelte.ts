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
  currentUserId = userId;
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey()) : null;
  activeOrg = stored;
}

export async function fetchOrgs(): Promise<void> {
  try {
    const { data } = await api.api.user.orgs.get();
    if (data && "orgs" in data) {
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

function getAvailableOrgs(): Org[] {
  return availableOrgs;
}

function getActiveOrg(): string | null {
  return activeOrg;
}

export function reset(): void {
  availableOrgs = [];
  activeOrg = null;
  currentUserId = null;
  // Intentionally NOT removing localStorage key — per-user org selection persists across account switches
}
