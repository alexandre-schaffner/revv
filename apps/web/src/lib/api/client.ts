import { treaty } from '@elysiajs/eden';
import type { App } from '@rev/server';
import { API_BASE_URL } from '@rev/shared';

export const api = treaty<App>(API_BASE_URL, {
	fetch: {
		credentials: 'include',
	},
	headers: () => {
		const token =
			typeof localStorage !== 'undefined' ? (localStorage.getItem('rev_session_token') ?? '') : '';
		return token ? { Authorization: `Bearer ${token}` } : {};
	},
});
