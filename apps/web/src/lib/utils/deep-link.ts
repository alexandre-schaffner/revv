import { listen } from '@tauri-apps/api/event';

export function initDeepLinkListener(onToken: (token: string) => void): Promise<() => void> {
	// Rust parses the deep-link plugin's JSON array and emits each URL individually
	// as a plain string on 'deep-link-url', so we can do a straight new URL() here.
	return listen<string>('deep-link-url', (event) => {
		try {
			const url = new URL(event.payload);
			const token = url.searchParams.get('token');
			if (token) onToken(token);
		} catch {
			// ignore malformed URLs
		}
	});
}
