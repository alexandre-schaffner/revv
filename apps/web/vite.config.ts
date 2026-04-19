import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	envPrefix: ['VITE_', 'TAURI_'],
	server: {
		port: 5173,
		strictPort: true
	},
	worker: {
		format: 'es'
	},
	build: {
		// shiki grammars + highlighter bring a few chunks past the default 500 kB
		// threshold; they're already lazy-loaded per language. Bump the warning
		// limit rather than emit noise on every build.
		chunkSizeWarningLimit: 1024
	}
});
