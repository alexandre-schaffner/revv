import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Short commit hash snapshotted at build time. We display this in
// Settings → Updates → "Current version" instead of the semver from
// tauri.conf.json so every build is individually identifiable during the
// alpha. Falls back to 'unknown' when git isn't available (shallow clone,
// CI without fetch-depth, source tarballs, …).
const commitHash = (() => {
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return 'unknown';
	}
})();

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	envPrefix: ['VITE_', 'TAURI_'],
	define: {
		__COMMIT_HASH__: JSON.stringify(commitHash)
	},
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
