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
	}
});
