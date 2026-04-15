const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Tiny URL-safe unique ID generator (no dependency needed). */
export function nanoid(size = 21): string {
	const bytes = crypto.getRandomValues(new Uint8Array(size));
	return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
