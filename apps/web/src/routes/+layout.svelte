<script lang="ts">
import "../app.css";
import IconContext from "phosphor-svelte/lib/IconContext";
import { onMount, untrack } from "svelte";
import { toast } from "svelte-sonner";
import { page } from "$app/state";
import { assertRuntimeChannel, fetchRuntimeHealth } from "$lib/api/runtime";
import ChatPanel from "$lib/components/chat/ChatPanel.svelte";
import PrDeepLinkCoordinator from "$lib/components/deep-link/PrDeepLinkCoordinator.svelte";
import AppShell from "$lib/components/layout/AppShell.svelte";
import OnboardingGate from "$lib/components/onboarding/OnboardingGate.svelte";
import { Toaster } from "$lib/components/ui/sonner";
import { TooltipProvider } from "$lib/components/ui/tooltip";
import { initGsap } from "$lib/motion";
import { detachSession, restoreSession, startSession } from "$lib/session/lifecycle.svelte";
import { getUser } from "$lib/stores/auth.svelte";
import { openPrDeepLink } from "$lib/stores/pr-deep-link.svelte";
import { getSelectedPrId } from "$lib/stores/route.svelte";
import { fetchAllModels, fetchSettings } from "$lib/stores/settings.svelte";
import { initShortcuts } from "$lib/stores/shortcuts.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { initTheme } from "$lib/stores/theme.svelte";
import { startUpdater, stopUpdater } from "$lib/updater/service";
import { warnIfServiceOutOfDate } from "$lib/updater/service-build-warning";

let { children } = $props();

// Covers the URL-driven paths (deep link, back/forward, refresh, SSE-driven
// nav); clicks go through `openPr`, which sets the view itself. Re-runs only
// when selectedPrId changes, so swiping back to the PR list while staying on
// /review/[prId] (Esc / 'h' / breadcrumb) is not clobbered.
$effect(() => {
  setSidebarView(getSelectedPrId() ? "files" : "prs");
});

// An identity appearing (restore, sign-in) starts its session.
// Only the user id is tracked: the session reads the token synchronously, and
// subscribing to it would restart the session on every token rotation.
$effect(() => {
  const userId = getUser()?.id;
  if (userId) untrack(() => startSession(userId));
});

// `onMount`, not `$effect`: `restoreSession()` and `fetchAllModels()` read the
// auth token before their first `await`, so an effect would re-run on every
// token change (better-auth hands back a refreshed `set-auth-token` on
// sign-in), re-arming the updater into a duplicate "Update available" toast.
onMount(() => {
  initGsap();
  const cleanupTheme = initTheme();
  const cleanupShortcuts = initShortcuts();
  let cleanupDeepLinks: (() => void) | undefined;

  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-deep-link").then(async ({ getCurrent, onOpenUrl }) => {
      const receive = (urls: string[]): void => {
        for (const url of urls) void openPrDeepLink(url);
      };
      cleanupDeepLinks = await onOpenUrl(receive);
      const current = await getCurrent().catch(() => null);
      if (current) receive(current);
    });
  }

  void fetchRuntimeHealth()
    .then((health) => {
      assertRuntimeChannel(health);
      warnIfServiceOutOfDate(health);
    })
    .catch((error: unknown) => {
      toast.error("Runtime channel unavailable", {
        id: "runtime-channel-error",
        description: error instanceof Error ? error.message : String(error),
        duration: 6000,
      });
    });

  restoreSession();
  void fetchAllModels();
  void fetchSettings().then(() => {
    // So the first update check doesn't compete with the initial PR sync
    // for network.
    setTimeout(() => {
      startUpdater();
    }, 5000);
  });

  return () => {
    cleanupTheme();
    cleanupShortcuts();
    cleanupDeepLinks?.();
    detachSession();
    stopUpdater();
  };
});
</script>

<!-- Iconography defaults (phosphor-svelte); call sites only state what differs.

	   weight "regular" — `weight="fill"` is reserved for *state*: the
	     on/active/selected half of a toggle, and severity markers where
	     solidity itself is the signal.
	   aria-hidden — phosphor stamps `role="img"` on every <svg>, and a role=img
	     with no accessible name is an unlabelled image (WCAG 1.1.1). Icons here
	     are decorative; the adjacent label or the button's own aria-label
	     carries the meaning. An icon that IS the only signal opts back in with
	     aria-hidden="false" plus an aria-label.

	 Props always beat context (phosphor resolves `props.x ?? ctx.x`), so both
	 defaults stay overridable per call site.

	 Imported from `lib/IconContext` rather than the package root on purpose:
	 `sveltePhosphorOptimize` rewrites every *named* import from
	 "phosphor-svelte" into `phosphor-svelte/lib/<name>`, which would turn
	 `{ setIconContext }` into a deep import of a module that does not exist. -->
<IconContext values={{ weight: "regular", "aria-hidden": "true" }}>
<TooltipProvider>
	<OnboardingGate>
		<AppShell>
			{@render children()}
			{#snippet rightPanel()}
				<ChatPanel />
			{/snippet}
		</AppShell>
	</OnboardingGate>
	<PrDeepLinkCoordinator />
	<Toaster />
</TooltipProvider>
</IconContext>
