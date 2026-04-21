import { treaty } from '@elysiajs/eden';
import type { App } from '@revv/server';
import { API_BASE_URL } from '$lib/api/base-url';
import { authHeaders } from '$lib/utils/session-token';

export const api = treaty<App>(API_BASE_URL, {
	fetch: {
		credentials: 'include',
	},
	headers: () => authHeaders(),
});
