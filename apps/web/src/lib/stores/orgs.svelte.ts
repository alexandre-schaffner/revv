import type { Org } from "@revv/shared";
import { api } from "$lib/api/client";
import { readStored, STORAGE_KEYS, textCodec, writeStored } from "$lib/stores/persisted.svelte";

let currentUserId = $state<string | null>(null);

const readActiveOrg = (): string | null =>
  readStored(STORAGE_KEYS.activeOrg(currentUserId), textCodec, null);

let availableOrgs = $state<Org[]>([]);
let activeOrg = $state<string | null>(readActiveOrg());

export function initForUser(userId: string): void {
  if (userId !== currentUserId) orgsLoadedAt = 0;
  currentUserId = userId;
  activeOrg = readActiveOrg();
}

const ORGS_FRESH_FOR_MS = 5 * 60 * 1000;
let orgsInflight: Promise<void> | null = null;
let orgsLoadedAt = 0;

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
  writeStored(STORAGE_KEYS.activeOrg(currentUserId), textCodec, login);
}

export function reset(): void {
  orgsLoadedAt = 0;
  availableOrgs = [];
  activeOrg = null;
  currentUserId = null;
  // The stored selection stays: it's per user and survives account switches.
}
