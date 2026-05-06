import type { Org } from '@revv/shared';
import { api } from '$lib/api/client';

const STORAGE_KEY = 'rev_active_org';

let availableOrgs = $state<Org[]>([]);
let activeOrg = $state<string | null>(
	typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null,
);

export async function fetchOrgs(): Promise<void> {
	try {
		const { data } = await api.api.user.orgs.get();
		if (data && 'orgs' in data) {
			availableOrgs = data.orgs as Org[];
			if (activeOrg && !availableOrgs.some((o) => o.login === activeOrg)) {
				setActiveOrg(null);
			}
		}
	} catch {
		// Silent degrade — same posture as /api/user/identity failures.
	}
}

export function setActiveOrg(login: string | null): void {
	activeOrg = login;
	if (typeof localStorage !== 'undefined') {
		if (login) localStorage.setItem(STORAGE_KEY, login);
		else localStorage.removeItem(STORAGE_KEY);
	}
}

export function getAvailableOrgs(): Org[] {
	return availableOrgs;
}

export function getActiveOrg(): string | null {
	return activeOrg;
}

export function reset(): void {
	availableOrgs = [];
	setActiveOrg(null);
}
