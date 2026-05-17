<script lang="ts">
import "../app.css";
import { page } from "$app/state";
import CacheInspector from "$lib/components/dev/CacheInspector.svelte";
import AppShell from "$lib/components/layout/AppShell.svelte";
import OnboardingGate from "$lib/components/onboarding/OnboardingGate.svelte";
import ErrorBanner from "$lib/components/shared/ErrorBanner.svelte";
import { Toaster } from "$lib/components/ui/sonner";
import { TooltipProvider } from "$lib/components/ui/tooltip";
import * as sync from "$lib/services/sync";
import * as auth from "$lib/stores/auth.svelte";
import * as prs from "$lib/stores/prs.svelte";
import * as settings from "$lib/stores/settings.svelte";
import { initShortcuts } from "$lib/stores/shortcuts.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { initTheme } from "$lib/stores/theme.svelte";
import { startUpdater, stopUpdater } from "$lib/updater/service";

let { children } = $props();
let hydrated = false;
let cacheInspectorOpen = $state(false);

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
$effect(() => {
  const match = page.url.pathname.match(/^\/review\/([^/]+)/);
  prs.setSelectedPrId(match?.[1] ?? null);
});

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
$effect(() => {
  const id = prs.getSelectedPrId();
  setSidebarView(id ? "files" : "prs");
});

$effect(() => {
  function handleKeydown(e: KeyboardEvent): void {
    if (import.meta.env.DEV && e.metaKey && e.shiftKey && e.key === "C") {
      e.preventDefault();
      cacheInspectorOpen = !cacheInspectorOpen;
    }
  }
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
});

// When user becomes authenticated, hydrate app data.
$effect(() => {
  const user = auth.getUser();
  if (user && !hydrated) {
    hydrated = true;
    hydrate();
  }
  if (!user) {
    hydrated = false;
  }
});

$effect(() => {
  const cleanupTheme = initTheme();
  const cleanupShortcuts = initShortcuts();

  // On mount: try to restore auth from localStorage.
  // If the token is valid, loadUser() sets the user, which triggers
  // the hydration effect above.
  auth.loadUser();
  // Fetch settings before arming the updater check loop.
  // Model prefetch doesn't block anything, so it starts in parallel.
  void settings.fetchAllModels();
  void settings.fetchSettings().then(() => {
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
    sync.stopPolling();
    stopUpdater();
  };
});

async function hydrate() {
  // Load cached data first (instant UI)
  await Promise.all([prs.fetchPrs(), prs.fetchRepos(), settings.fetchSettings()]);

  // Then kick off a live sync from GitHub
  const token = auth.getToken();
  if (!token) return;

  const s = settings.getSettings();
  const interval = s?.autoFetchInterval ?? 5;
  sync.startPolling(interval, token);
}
</script>

<TooltipProvider>
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
</TooltipProvider>
