<script lang="ts">
import "../app.css";
import { page } from "$app/state";
import { assertRuntimeChannel } from "$lib/api/runtime";
import CacheInspector from "$lib/components/dev/CacheInspector.svelte";
import AppShell from "$lib/components/layout/AppShell.svelte";
import OnboardingGate from "$lib/components/onboarding/OnboardingGate.svelte";
import ErrorBanner from "$lib/components/shared/ErrorBanner.svelte";
import { Toaster } from "$lib/components/ui/sonner";
import { TooltipProvider } from "$lib/components/ui/tooltip";
import { initGsap } from "$lib/motion";
import { initObservability, tracedEffect } from "$lib/observability";
import ObsPanel from "$lib/observability/Panel.svelte";
import { startPolling, stopPolling } from "$lib/services/sync";
import { getToken, getUser, loadUser } from "$lib/stores/auth.svelte";
import {
  fetchPinnedPrs,
  fetchPrs,
  fetchRepos,
  getSelectedPr,
  getSelectedPrId,
  setSelectedPrId,
  setSelectedRepoId,
} from "$lib/stores/prs.svelte";
import { fetchAllModels, fetchSettings, getSettings } from "$lib/stores/settings.svelte";
import { initShortcuts } from "$lib/stores/shortcuts.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { initTheme } from "$lib/stores/theme.svelte";
import { startUpdater, stopUpdater } from "$lib/updater/service";

let { children } = $props();
let hydrated = false;
let cacheInspectorOpen = $state(false);
let obsPanelOpen = $state(false);
let runtimeError = $state<string | null>(null);

// Keep `selectedPrId` in sync with the URL.
//
// Previously the store was only written to when a PR page mounted, and
// never cleared when navigating away. That stale value drove
// `PrItem`'s `isSelected` prop, so after leaving a PR (e.g. Cmd+W
// → homepage) the sidebar still thought that PR was selected — and
// clicking it just toggled the file-tree expander instead of
// navigating back. Deriving from the URL here makes the URL the
// single source of truth for every entry/exit path (Cmd+W, sidebar
// settings link, logout, mouse back, deep link, WS-driven nav, …).
$effect(() =>
  tracedEffect("layout.url-to-prId", () => {
    const match = page.url.pathname.match(/^\/review\/([^/]+)/);
    setSelectedPrId(match?.[1] ?? null);
  }),
);

// URL → selectedRepoId. The rail's active highlight and the project
// column's content both read from this store. Resolution order:
//   1. /repo/{id}/... — repoId is explicit in the path.
//   2. /review/{prId} — derive from the active PR's repositoryId.
//   3. Everything else (/, /settings, …) — null.
//
// Same single-source-of-truth pattern as selectedPrId. Re-runs whenever
// the URL changes or when the active PR resolves (the latter matters on
// cold-load of /review/{prId} when prs haven't been hydrated yet).
$effect(() =>
  tracedEffect("layout.url-to-repoId", () => {
    const path = page.url.pathname;
    const repoMatch = path.match(/^\/repo\/([^/]+)/);
    if (repoMatch?.[1]) {
      setSelectedRepoId(repoMatch[1]);
      return;
    }
    const selectedPr = getSelectedPr();
    setSelectedRepoId(selectedPr?.repositoryId ?? null);
  }),
);

// Keep the sidebar view in lockstep with the URL in both directions.
// PrItem.handleClick and CommandPalette already pair selectPr() with
// setSidebarView('files') so the click-driven path is in sync. This
// effect covers every URL-driven path that doesn't go through those
// handlers — deep link, browser back/forward, refresh, WS-driven nav,
// settings-link round-trip — and was previously one-sided (only reset
// to 'prs' when the route left a PR), which let the header (OrgSwitcher)
// and the body (file tree, because selectedPrId was set) desync.
// Re-runs only when selectedPrId changes, so a manual swipe-back to the
// PR list while staying on /review/[prId] (Esc / 'h' / breadcrumb) is
// not clobbered.
//
// New-PR chat sessions also live in files-mode: the left pane shows the
// worktree file tree while the main pane hosts the agent chat.
$effect(() =>
  tracedEffect("layout.sidebar-view", () => {
    const id = getSelectedPrId();
    const onNewPr = /^\/repo\/[^/]+\/new-pr\/[^/]+/.test(page.url.pathname);
    setSidebarView(id || onNewPr ? "files" : "prs");
  }),
);

$effect(() => {
  function handleKeydown(e: KeyboardEvent): void {
    if (import.meta.env.DEV && e.metaKey && e.shiftKey && e.key === "C") {
      e.preventDefault();
      cacheInspectorOpen = !cacheInspectorOpen;
    }
    // Ctrl+Shift+O — toggle the observability inspector. Dev-only so the
    // bundle doesn't ship the panel binding in production. The panel
    // component itself is statically imported but tree-shakes from prod
    // builds via the `import.meta.env.DEV` guard on the render below.
    if (import.meta.env.DEV && e.ctrlKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
      e.preventDefault();
      obsPanelOpen = !obsPanelOpen;
    }
  }
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
});

// When user becomes authenticated, hydrate app data.
$effect(() =>
  tracedEffect("layout.auth-hydrate", () => {
    const user = getUser();
    if (user && !hydrated) {
      hydrated = true;
      hydrate();
    }
    if (!user) {
      hydrated = false;
    }
  }),
);

$effect(() => {
  initObservability();
  initGsap();
  const cleanupTheme = initTheme();
  const cleanupShortcuts = initShortcuts();

  void assertRuntimeChannel().catch((error: unknown) => {
    runtimeError = error instanceof Error ? error.message : String(error);
  });

  // On mount: try to restore auth from localStorage.
  // If the token is valid, loadUser() sets the user, which triggers
  // the hydration effect above.
  loadUser();
  // Fetch settings before arming the updater check loop.
  // Model prefetch doesn't block anything, so it starts in parallel.
  void fetchAllModels();
  void fetchSettings().then(() => {
    // 5s delay so the first update check doesn't compete with
    // initial PR sync for network. After that the service runs on
    // its own hourly timer. Tauri-only — the service no-ops in dev.
    setTimeout(() => {
      startUpdater();
    }, 5000);
  });

  return () => {
    cleanupTheme();
    cleanupShortcuts();
    stopPolling();
    stopUpdater();
  };
});

async function hydrate() {
  // Load cached data first (instant UI)
  await Promise.all([fetchPrs(), fetchRepos(), fetchPinnedPrs(), fetchSettings()]);

  // Then kick off a live sync from GitHub
  const token = getToken();
  if (!token) return;

  const s = getSettings();
  const interval = s?.autoFetchInterval ?? 5;
  startPolling(interval, token);
}
</script>

<TooltipProvider>
	{#if runtimeError}
		<div class="runtime-channel-error" role="alert">
			{runtimeError}
		</div>
	{/if}
	<OnboardingGate>
		<AppShell>
			<ErrorBanner />
			{@render children()}
		</AppShell>
	</OnboardingGate>
	<Toaster />
	{#if import.meta.env.DEV && cacheInspectorOpen}
		<CacheInspector onclose={() => { cacheInspectorOpen = false; }} />
	{/if}
	{#if import.meta.env.DEV && obsPanelOpen}
		<ObsPanel onclose={() => { obsPanelOpen = false; }} />
	{/if}
</TooltipProvider>

<style>
	.runtime-channel-error {
		position: fixed;
		z-index: 9999;
		inset: 12px 12px auto 12px;
		border: 1px solid var(--color-destructive);
		border-radius: 8px;
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
		box-shadow: 0 12px 40px color-mix(in srgb, black 18%, transparent);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.4;
	}
</style>
