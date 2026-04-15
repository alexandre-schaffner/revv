import { createAuthClient } from 'better-auth/svelte';
import { API_BASE_URL } from '@rev/shared';

export const authClient = createAuthClient({
	baseURL: API_BASE_URL,
	fetchOptions: {
		auth: {
			type: 'Bearer',
			token: () => {
				if (typeof localStorage === 'undefined') return '';
				return localStorage.getItem('rev_session_token') ?? '';
			},
		},
		onSuccess: (ctx) => {
			const token = ctx.response.headers.get('set-auth-token');
			if (token && typeof localStorage !== 'undefined') {
				localStorage.setItem('rev_session_token', token);
			}
		},
	},
});
