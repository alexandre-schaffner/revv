// Ambient declarations for build-time constants injected by Vite.
// Keep this file minimal — SvelteKit generates its own ambient types into
// `.svelte-kit/ambient.d.ts` and picks this file up via the default
// `tsconfig.json` include.

/**
 * Short git commit hash captured by `vite.config.ts` via `execSync` when
 * the dev server starts or a production build runs. Always a string
 * (falls back to the literal `"unknown"` when git isn't available).
 */
declare const __COMMIT_HASH__: string;
