import { createAuthClient } from 'better-auth/svelte';
import { API_BASE_URL } from '$lib/api/base-url';
import { getToken, setToken } from '$lib/stores/auth.svelte';

export const authClient = createAuthClient({
	baseURL: API_BASE_URL,
	fetchOptions: {
		auth: {
			type: 'Bearer',
			token: () => getToken() ?? '',
		},
		onSuccess: (ctx) => {
			const token = ctx.response.headers.get('set-auth-token');
			if (token) {
				setToken(token);
			}
		},
	},
});
