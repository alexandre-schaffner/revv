import { treaty } from '@elysiajs/eden';
import type { App } from '@rev/server';
import { API_BASE_URL } from '@rev/shared';
import { authHeaders } from '$lib/utils/session-token';

export const api = treaty<App>(API_BASE_URL, {
	fetch: {
		credentials: 'include',
	},
	headers: () => authHeaders(),
});
