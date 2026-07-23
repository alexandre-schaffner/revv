<script lang="ts">
import {
  ACP_AGENTS,
  type AcpAgentId,
  type AgentStatus,
  type AgentStatusReport,
  getAgentKeychainAuth,
  type InstallEvent,
  type RecapAgentChoice,
  type Repository,
} from "@revv/shared";
import { Dialog as DialogPrimitive } from "bits-ui";
import RotateCcw from "phosphor-svelte/lib/ArrowCounterClockwise";
import ExternalLink from "phosphor-svelte/lib/ArrowSquareOut";
import CalendarClock from "phosphor-svelte/lib/CalendarCheck";
import Cloud from "phosphor-svelte/lib/Cloud";
import Cpu from "phosphor-svelte/lib/Cpu";
import Monitor from "phosphor-svelte/lib/Desktop";
import Download from "phosphor-svelte/lib/Download";
import Moon from "phosphor-svelte/lib/Moon";
import SlidersHorizontal from "phosphor-svelte/lib/SlidersHorizontal";
import Loader2 from "phosphor-svelte/lib/Spinner";
import Sun from "phosphor-svelte/lib/Sun";
import Trash2 from "phosphor-svelte/lib/Trash";
import User from "phosphor-svelte/lib/User";
import TriangleAlert from "phosphor-svelte/lib/Warning";
import X from "phosphor-svelte/lib/X";
import { onDestroy } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { goto } from "$app/navigation";
import { API_BASE_URL } from "$lib/api/base-url";
import SignInButton from "$lib/components/auth/SignInButton.svelte";
import AgentLoginTerminal from "$lib/components/onboarding/AgentLoginTerminal.svelte";
import RepoDeleteConfirm from "$lib/components/sidebar/RepoDeleteConfirm.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Switch } from "$lib/components/ui/switch";
import { getUser, removeAccount, resetOnboarding, signOut } from "$lib/stores/auth.svelte";
import { deleteRepo, getRepositories } from "$lib/stores/prs.svelte";
import {
  type AgentKeychainResult,
  cascadeChatAgentChange,
  checkAgentKeychain,
  fetchAgentStatus,
  fetchModels,
  getAgentStatus,
  getAvailableModels,
  getSettings,
  updateSettings,
} from "$lib/stores/settings.svelte";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";
import {
  type AgentInstallState,
  agentInstallLog,
  appendAgentInstallLog,
  runAgentInstall,
} from "$lib/utils/agent-install";
import { authHeaders } from "$lib/utils/session-token";
import UpdatesSection from "./UpdatesSection.svelte";
import "./settings-layout.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

let { open, onClose }: Props = $props();

// ── Nav sections ──────────────────────────────────────────────────────────
type SectionId =
  | "account"
  | "ai"
  | "recap"
  | "cache"
  | "preferences"
  | "onboarding"
  | "updates"
  | "danger";

interface NavItem {
  id: SectionId;
  label: string;
  icon: typeof User;
}

const navItems: NavItem[] = [
  { id: "account", label: "Account", icon: User },
  { id: "ai", label: "AI Configuration", icon: Cpu },
  { id: "recap", label: "Project Recap", icon: CalendarClock },
  { id: "cache", label: "Team Cache", icon: Cloud },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "onboarding", label: "Onboarding", icon: RotateCcw },
  { id: "updates", label: "Updates", icon: Download },
  { id: "danger", label: "Danger Zone", icon: TriangleAlert },
];

// ── Team-cache "Test connection" state ────────────────────────────────────
let cacheTestState = $state<{ healthy: boolean; detail: string } | null>(null);
let cacheTestRunning = $state(false);
async function testCacheConnection(): Promise<void> {
  if (cacheTestRunning) return;
  cacheTestRunning = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/status`, {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      cacheTestState = { healthy: false, detail: `HTTP ${res.status}` };
      return;
    }
    cacheTestState = (await res.json()) as { healthy: boolean; detail: string };
  } catch (e) {
    cacheTestState = {
      healthy: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    cacheTestRunning = false;
  }
}

// ── ADC (Application Default Credentials) status ──────────────────────────
type AdcStatus =
  | { available: true; source: string; gcloudFound: boolean; gcloudPath: string | null }
  | {
      available: false;
      source: null;
      gcloudFound: boolean;
      gcloudPath: string | null;
      adcPath: string | null;
    };
let adcStatus = $state<AdcStatus | null>(null);
let adcPolling = $state(false);

async function fetchAdcStatus(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/adc-status`, {
      headers: await authHeaders(),
    });
    if (!res.ok) return;
    adcStatus = (await res.json()) as AdcStatus;
  } catch {
    // ignore
  }
}

async function startAdcLogin(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/adc-login`, {
      method: "POST",
      headers: await authHeaders(),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { started: boolean; error?: string };
    if (!data.started) return;
    // Poll until ADC becomes available
    adcPolling = true;
    const interval = setInterval(async () => {
      await fetchAdcStatus();
      if (adcStatus?.available) {
        clearInterval(interval);
        adcPolling = false;
      }
    }, 2000);
    // Stop polling after 60 seconds
    setTimeout(() => {
      clearInterval(interval);
      adcPolling = false;
    }, 60000);
  } catch {
    // ignore
  }
}

$effect(() => {
  if (open && getSettings()?.cache?.enabled) {
    void fetchAdcStatus();
  }
});

// ── Cache signing — "Test signing" state ──────────────────────────────────
// Round-trips a probe message through the local SSH key + the user's published
// `.keys`. Surfaces the specific signer service error verbatim so a user can
// see e.g. "no key in ~/.ssh matches your GitHub keys" or ssh-keygen output.
type SigningTestResult =
  | { ok: true; signerLogin: string; signerHost: string; signatureNamespace: string }
  | { ok: false; error: string };
let signingTestState = $state<SigningTestResult | null>(null);
let signingTestRunning = $state(false);
async function testCacheSigning(): Promise<void> {
  if (signingTestRunning) return;
  signingTestRunning = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/signing/test`, {
      method: "POST",
      headers: await authHeaders(),
    });
    if (!res.ok) {
      signingTestState = { ok: false, error: `HTTP ${res.status}` };
      return;
    }
    signingTestState = (await res.json()) as SigningTestResult;
  } catch (e) {
    signingTestState = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    signingTestRunning = false;
  }
}

const signingModeOptions: { value: "off" | "permissive" | "strict"; label: string }[] = [
  { value: "strict", label: "Strict — require valid signature" },
  { value: "permissive", label: "Permissive — sign on push, warn on bad sig" },
  { value: "off", label: "Off — no signing or verification" },
];

function trustedHostsToText(hosts: readonly string[] | undefined): string {
  return (hosts ?? []).join(", ");
}

function parseTrustedHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}

// ── Recap agent selector options ──────────────────────────────────────────
const recapAgentOptions: { value: RecapAgentChoice; label: string }[] = [
  { value: "auto", label: "Auto (follow main agent)" },
  ...ACP_AGENTS.map((a) => ({ value: a.id, label: a.label })),
];

let activeSection = $state<SectionId>("account");
let contentEl = $state<HTMLElement | null>(null);

// ── IntersectionObserver to highlight active nav ──────────────────────────
$effect(() => {
  if (!contentEl || !open) return;

  const sectionEls = navItems
    .map((n) => contentEl?.querySelector<HTMLElement>(`#section-${n.id}`))
    .filter((el): el is HTMLElement => el !== null);

  if (sectionEls.length === 0) return;

  const ratios = new SvelteMap<string, number>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        ratios.set(entry.target.id, entry.intersectionRatio);
      }
      // Pick the section with the highest intersection ratio
      let bestId: string | null = null;
      let bestRatio = -1;
      for (const [id, ratio] of ratios) {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestId = id;
        }
      }
      if (bestId) {
        activeSection = bestId.replace("section-", "") as SectionId;
      }
    },
    {
      root: contentEl,
      threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0],
    },
  );

  for (const el of sectionEls) {
    observer.observe(el);
  }

  return () => observer.disconnect();
});

function scrollToSection(id: SectionId): void {
  if (!contentEl) return;
  const el = contentEl.querySelector<HTMLElement>(`#section-${id}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ── Avatar ────────────────────────────────────────────────────────────────
// URL-keyed: failed state is only true while the current URL is the one that
// errored. If the URL rotates (e.g. after re-login), the new URL is retried.
let _userAvatarFailedForUrl = $state<string | null>(null);
const userAvatarFailed = $derived(
  _userAvatarFailedForUrl !== null && _userAvatarFailedForUrl === (getUser()?.image ?? null),
);

// ── Sync interval options ─────────────────────────────────────────────────
const intervalOptions = [
  { label: "Disabled", value: 0 },
  { label: "1 minute", value: 1 },
  { label: "5 minutes", value: 5 },
  { label: "10 minutes", value: 10 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
];

// ── AI Configuration ──────────────────────────────────────────────────────
let aiConfigured = $state(false);
let aiStatusLoading = $state(true);
let providerStatus = $state<AgentStatusReport | null>(getAgentStatus());
let providerStatusLoading = $state(false);
let aiAgent = $derived(getSettings()?.aiAgent ?? "opencode");
let currentAgent = $derived(ACP_AGENTS.find((a) => a.id === aiAgent));
let currentAgentStatus = $derived(providerStatus?.agents[aiAgent] ?? null);
let modelOptions = $derived(getAvailableModels(aiAgent));
let currentSuggestionsModel = $derived(getSettings()?.aiSuggestionsModel ?? "");
let currentSuggestionsModelLabel = $derived(
  modelOptions.find((o) => o.value === currentSuggestionsModel)?.label ?? currentSuggestionsModel,
);

let providerInstall = $state<AgentInstallState>({ kind: "idle" });
let providerInstallAbort: AbortController | null = null;
let signingInAgent = $state<AcpAgentId | null>(null);
let selectedLoginCommand = $derived(currentAgentStatus?.loginCommand ?? `${aiAgent} login`);

$effect(() => {
  if (open) {
    fetchAiStatus();
    void refreshProviderStatus();
    // Populate the suggestions-model dropdown for the current agent (boot
    // prefetch usually covers this; this backstops a cold cache).
    void fetchModels(aiAgent);
  }
});

onDestroy(() => {
  providerInstallAbort?.abort();
});

// ── Agent keychain access check (Solution B: guide, don't store) ───────────
// Shown only for keychain-backed agents (registry-declared); today that's
// Claude Code, but any provider that adds `keychainAuth` surfaces here.
let agentKeychainAuth = $derived(getAgentKeychainAuth(aiAgent));
let keychainChecking = $state(false);
let keychainResult = $state<AgentKeychainResult | null>(null);

async function handleCheckAgentKeychain(): Promise<void> {
  keychainChecking = true;
  try {
    keychainResult = await checkAgentKeychain(aiAgent);
  } finally {
    keychainChecking = false;
  }
}

// Drop a stale result when the selected agent changes.
$effect(() => {
  void aiAgent;
  keychainResult = null;
  providerInstallAbort?.abort();
  providerInstallAbort = null;
  providerInstall = { kind: "idle" };
  signingInAgent = null;
});

async function fetchAiStatus(): Promise<void> {
  aiStatusLoading = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/ai-status`, {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = (await res.json()) as { configured: boolean; model: string };
      aiConfigured = data.configured;
    }
  } catch {
    // Ignore — status will show as unconfigured
  } finally {
    aiStatusLoading = false;
  }
}

async function refreshProviderStatus(options: { refresh?: boolean } = {}): Promise<void> {
  providerStatusLoading = true;
  try {
    providerStatus = await fetchAgentStatus(options);
  } finally {
    providerStatusLoading = false;
  }
}

function providerReady(s: AgentStatus | null | undefined): boolean {
  return !!s?.installed && s.authed;
}

function providerStatusText(s: AgentStatus | null | undefined): string {
  if (!s) return "Not checked";
  if (!s.installed) return "Agent not installed";
  if (!s.authed) return "Needs sign-in";
  return s.authLabel;
}

function providerStateLabel(s: AgentStatus | null | undefined): string {
  if (!providerReady(s)) return "Action needed";
  return s?.verified ? "Connected" : "Configured";
}

function agentLabel(agent: AcpAgentId): string {
  return ACP_AGENTS.find((a) => a.id === agent)?.label ?? agent;
}

function providerInstallLabel(state: AgentInstallState): string {
  return state.kind === "idle" ? "" : agentLabel(state.agent);
}

function retryProviderInstall(state: AgentInstallState): void {
  if (state.kind !== "failed") return;
  void handleProviderInstall(state.agent);
}

async function handleProviderChange(value: string | undefined): Promise<void> {
  if (!value || value === aiAgent) return;
  const agent = value as AcpAgentId;
  if (agent === "opencode") void fetchModels("opencode");
  await updateSettings(cascadeChatAgentChange(agent));
  void fetchModels(agent);
  void refreshProviderStatus();
}

function currentProviderLog(): string[] {
  return agentInstallLog(providerInstall);
}

async function handleProviderInstall(agent: AcpAgentId): Promise<void> {
  providerInstallAbort?.abort();
  providerInstall = { kind: "running", agent, log: [] };
  try {
    const ctrl = new AbortController();
    providerInstallAbort = ctrl;
    await runAgentInstall(agent, ctrl.signal, (event) => applyProviderInstallEvent(event, agent));
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    providerInstall = {
      kind: "failed",
      agent,
      log: currentProviderLog(),
      error: err instanceof Error ? err.message : "Install failed",
    };
  } finally {
    providerInstallAbort = null;
  }
}

async function applyProviderInstallEvent(event: InstallEvent, agent: AcpAgentId): Promise<void> {
  if (event.type === "log") {
    providerInstall = appendAgentInstallLog(providerInstall, agent, event.line);
    return;
  }
  if (!event.success) {
    providerInstall = {
      kind: "failed",
      agent,
      log: currentProviderLog(),
      error: event.error ?? "Install failed",
    };
    return;
  }

  providerStatus = await fetchAgentStatus();
  providerInstall = { kind: "idle" };
  if (providerStatus?.agents[agent]?.authed === false && providerStatus.embeddedLoginSupported) {
    signingInAgent = agent;
  }
}

function handleProviderSignIn(agent: AcpAgentId): void {
  signingInAgent = agent;
}

async function onProviderLoginDone(): Promise<void> {
  providerStatus = await fetchAgentStatus();
  signingInAgent = null;
  await fetchAiStatus();
}

function onProviderLoginSkip(): void {
  signingInAgent = null;
}

// ── Max turns ─────────────────────────────────────────────────────────────
const MAX_TURNS_MIN = 10;
const MAX_TURNS_MAX = 500;
let maxTurnsDraft = $state<string>(String(getSettings()?.aiMaxTurns ?? 60));
let lastCommittedMaxTurns = $state<number | null>(getSettings()?.aiMaxTurns ?? null);

$effect(() => {
  const current = getSettings()?.aiMaxTurns;
  if (typeof current !== "number") return;
  if (current !== lastCommittedMaxTurns) {
    maxTurnsDraft = String(current);
    lastCommittedMaxTurns = current;
  }
});

function commitMaxTurns(): void {
  const parsed = Number.parseInt(maxTurnsDraft, 10);
  const current = getSettings()?.aiMaxTurns ?? 60;
  if (!Number.isFinite(parsed)) {
    maxTurnsDraft = String(current);
    return;
  }
  const clamped = Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, parsed));
  maxTurnsDraft = String(clamped);
  if (clamped === current) return;
  lastCommittedMaxTurns = clamped;
  void updateSettings({ aiMaxTurns: clamped });
}

// ── Onboarding ────────────────────────────────────────────────────────────
let replaying = $state(false);

async function handleReplayOnboarding(): Promise<void> {
  replaying = true;
  try {
    await resetOnboarding();
    onClose();
    await goto("/");
  } finally {
    replaying = false;
  }
}

// ── Danger Zone ───────────────────────────────────────────────────────────
let showDeleteConfirm = $state(false);
let deleting = $state(false);
let deleteError = $state<string | null>(null);

let removingRepoId = $state<string | null>(null);
let repoPendingDelete = $state<Repository | null>(null);

async function handleDeleteRepo(id: string): Promise<void> {
  removingRepoId = id;
  try {
    await deleteRepo(id);
    repoPendingDelete = null;
  } finally {
    removingRepoId = null;
  }
}

async function handleRemoveAccount(): Promise<void> {
  deleting = true;
  deleteError = null;
  try {
    await removeAccount();
    onClose();
  } catch (e) {
    deleteError = e instanceof Error ? e.message : "Failed to remove account. Please try again.";
  } finally {
    deleting = false;
  }
}

// ── Theme options ────────────────────────────────────────────────────────

const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];
</script>

<DialogPrimitive.Root
	{open}
	onOpenChange={(v) => {
		if (!v) onClose();
	}}
>
	<Dialog.Portal>
		<Dialog.Overlay />
		<DialogPrimitive.Content
			data-slot="dialog-content"
			class="settings-modal"
		>
			<!-- Left sidebar nav -->
			<nav class="settings-sidebar" aria-label="Settings navigation">
				<div class="settings-sidebar-header">
					<span class="settings-title">Settings</span>
				</div>
				<ul class="settings-nav" role="list">
					{#each navItems as item (item.id)}
						<li>
							<button
								class="settings-nav-item"
								class:settings-nav-item--active={activeSection === item.id}
								class:settings-nav-item--danger={item.id === 'danger'}
								onclick={() => scrollToSection(item.id)}
								type="button"
							>
								<item.icon size={13} class="settings-nav-icon" />
								<span class="settings-nav-label">{item.label}</span>
							</button>
						</li>
					{/each}
				</ul>
				<!-- User info at bottom of sidebar -->
				{#if getUser()}
					<div class="settings-sidebar-user">
						{#if getUser()?.image && !userAvatarFailed}
							<img
								src={getUser()?.image}
								alt=""
								class="settings-sidebar-avatar"
								referrerpolicy="no-referrer"
								onerror={() => (_userAvatarFailedForUrl = getUser()?.image ?? null)}
							/>
						{:else}
							<span class="settings-sidebar-avatar settings-sidebar-avatar--fallback" aria-hidden="true">
								<User size={11} weight="regular" />
							</span>
						{/if}
						<span class="settings-sidebar-username">{getUser()?.githubLogin ?? getUser()?.name ?? 'Account'}</span>
					</div>
				{/if}
			</nav>

			<!-- Right scrollable content -->
			<div class="settings-content" bind:this={contentEl}>
			<!-- Close button -->
			<Button
				variant="ghost"
				size="icon-sm"
				style="position: absolute; top: 12px; right: 12px; z-index: 10;"
				onclick={onClose}
				aria-label="Close settings"
			>
					<X size={14} weight="fill" />
				</Button>

				<!-- Account -->
				<section id="section-account" class="settings-section">
					<h2 class="section-head-title">Account</h2>
					{#if getUser()}
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								{#if getUser()?.image && !userAvatarFailed}
									<img
										src={getUser()?.image}
										alt={getUser()?.name}
										class="h-9 w-9 rounded-full"
										referrerpolicy="no-referrer"
										onerror={() => (_userAvatarFailedForUrl = getUser()?.image ?? null)}
									/>
								{:else}
									<div class="flex h-9 w-9 items-center justify-center rounded-full bg-bg-elevated text-text-muted">
										<User size={18} weight="regular" aria-hidden="true" />
									</div>
								{/if}
								<div>
									<p class="text-sm font-medium text-text-primary">{getUser()?.name}</p>
									<p class="text-xs text-text-muted">{getUser()?.email}</p>
								</div>
							</div>
							<Button variant="outline" size="sm" onclick={signOut} class="text-xs hover:border-danger hover:text-danger">
								Sign out
							</Button>
						</div>
						<p class="mt-3 text-xs text-text-muted">
							Signing out clears Revv's local copy of your GitHub token. To revoke Revv's access on
							GitHub's side, visit
							<a
								href="https://github.com/settings/applications"
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-accent-hover"
							>
								your authorized applications
								<ExternalLink size={10} weight="fill" />
							</a>.
						</p>
					{:else}
						<div class="flex items-center justify-between">
							<p class="text-sm text-text-muted">Not signed in</p>
							<SignInButton />
						</div>
					{/if}
			</section>

			<!-- AI Configuration -->
			<section id="section-ai" class="settings-section">
				<h2 class="section-head-title">AI Configuration</h2>

				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Provider</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Active provider</p>
							<p class="settings-row-hint">
								{#if providerStatusLoading}
									Checking provider connection…
								{:else}
									{providerStatusText(currentAgentStatus)}
								{/if}
							</p>
							{#if currentAgentStatus?.authWarning}
								<p class="provider-warning">
									<TriangleAlert size={12} weight="fill" />
									<span>{currentAgentStatus.authWarning}</span>
								</p>
							{/if}
						</div>
						<div class="provider-status-action">
							<Select.Root type="single" value={aiAgent} onValueChange={handleProviderChange}>
								<Select.Trigger class="w-40 text-xs truncate">
									{currentAgent?.label ?? 'Agent'}
								</Select.Trigger>
								<Select.Content>
									{#each ACP_AGENTS as agent (agent.id)}
										<Select.Item value={agent.id} class="text-xs">{agent.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
							<div class="status-line">
								{#if providerStatusLoading}
									<Loader2 size={11} weight="regular" class="motion-essential-spin text-text-muted" />
									<span class="status-line-text">Checking</span>
								{:else if providerReady(currentAgentStatus)}
									<span
										class="status-line-dot"
										class:status-line-dot--success={currentAgentStatus?.verified}
										class:status-line-dot--warning={!currentAgentStatus?.verified}
										aria-hidden="true"
									></span>
									<span class="status-line-text">{providerStateLabel(currentAgentStatus)}</span>
								{:else}
									<span class="status-line-dot status-line-dot--warning" aria-hidden="true"></span>
									<span class="status-line-text">Action needed</span>
								{/if}
							</div>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => refreshProviderStatus({ refresh: true })}
								disabled={providerStatusLoading}
								class="text-xs"
							>
								Check again
							</Button>
						</div>
					</div>

					{#if signingInAgent}
						<div class="provider-login-terminal">
							<AgentLoginTerminal
								agent={signingInAgent}
								agentLabel={ACP_AGENTS.find((a) => a.id === signingInAgent)?.label ?? signingInAgent}
								onDone={onProviderLoginDone}
								onSkip={onProviderLoginSkip}
							/>
						</div>
					{:else if providerInstall.kind === 'running'}
						<div class="provider-setup-panel">
							<div class="provider-setup-heading">
								<Loader2 size={12} weight="regular" class="motion-essential-spin text-text-muted" />
								<span>Installing {providerInstallLabel(providerInstall)}</span>
							</div>
							<div class="provider-install-log">
								{#if providerInstall.log.length > 0}
									{#each providerInstall.log as line, i (i)}
										<div class="provider-install-log-line">{line}</div>
									{/each}
								{:else}
									<div class="provider-install-log-line provider-install-log-line--muted">Starting installer…</div>
								{/if}
							</div>
						</div>
					{:else if providerInstall.kind === 'failed'}
						<div class="provider-setup-panel provider-setup-panel--error">
							<div class="provider-install-log">
								{#each providerInstall.log as line, i (i)}
									<div class="provider-install-log-line">{line}</div>
								{/each}
								<div class="provider-install-log-line provider-install-log-line--error">{providerInstall.error}</div>
							</div>
							<div class="provider-setup-actions">
								<Button size="sm" class="text-xs" onclick={() => retryProviderInstall(providerInstall)}>
									Retry install
								</Button>
							</div>
						</div>
					{:else if currentAgentStatus && !currentAgentStatus.installed}
						<div class="provider-setup-actions">
							<Button size="sm" class="text-xs" onclick={() => handleProviderInstall(aiAgent)}>
								Install {currentAgent?.label ?? 'provider'}
							</Button>
						</div>
					{:else if currentAgentStatus && !currentAgentStatus.authed && providerStatus?.embeddedLoginSupported}
						<div class="provider-setup-actions">
							<Button size="sm" class="text-xs" onclick={() => handleProviderSignIn(aiAgent)}>
								Sign in to {currentAgent?.label ?? 'provider'}
							</Button>
						</div>
					{:else if currentAgentStatus && !currentAgentStatus.authed}
						<div class="provider-manual-login">
							<span>Run this in a terminal, then click Check again:</span>
							<code>{selectedLoginCommand}</code>
						</div>
					{/if}
				</div>

				<!-- Suggestions model (agent, review model, context window, and thinking
				     effort are configured from the chat bottom bar). -->
				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Models</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Suggestions model</p>
							<p class="settings-row-hint">
								Low-cost model used for PR-aware suggestion prompts in the right panel.
							</p>
						</div>
						<Select.Root
							type="single"
							value={currentSuggestionsModel}
							onValueChange={(v) => {
								if (v) void updateSettings({ aiSuggestionsModel: v });
							}}
						>
							<Select.Trigger class="w-52 text-xs truncate">
								{currentSuggestionsModelLabel || 'Select model…'}
							</Select.Trigger>
							<Select.Content>
								{#each modelOptions as opt (opt.value)}
									<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>

				<!-- Keychain access (only for keychain-backed agents, e.g. Claude Code) -->
				{#if agentKeychainAuth}
					<div class="settings-subgroup">
						<h3 class="settings-subgroup-heading">Keychain access</h3>

						<div class="settings-row">
							<div class="settings-row-info">
								<p class="settings-row-label">Background access</p>
								<p class="settings-row-hint">
									Report generation runs in Revv's background service, which needs permission to
									read your {currentAgent?.label ?? 'agent'} login from the macOS Keychain. Check
									whether it's allowed.
								</p>
							</div>
							<Button
								size="sm"
								variant="secondary"
								class="text-xs"
								disabled={keychainChecking}
								onclick={handleCheckAgentKeychain}
							>
								{#if keychainChecking}
									<Loader2 size={12} weight="regular" class="motion-essential-spin" />
									Checking…
								{:else}
									Check access
								{/if}
							</Button>
						</div>

						{#if keychainResult}
							<div class="status-line">
								{#if keychainResult.readable === true}
									<span class="status-line-dot status-line-dot--success" aria-hidden="true"></span>
									<span class="status-line-text"
										>Revv can read your {currentAgent?.label ?? 'agent'} login — you're set.</span
									>
								{:else if keychainResult.readable === false}
									<span class="status-line-dot status-line-dot--warning" aria-hidden="true"></span>
									<span class="status-line-text">{keychainResult.remediation}</span>
								{:else}
									<span class="status-line-dot status-line-dot--muted" aria-hidden="true"></span>
									<span class="status-line-text">Check unavailable on this platform.</span>
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Limits -->
				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Limits</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Max turns</p>
							<p class="settings-row-hint">
								Maximum agent turns per review ({MAX_TURNS_MIN}–{MAX_TURNS_MAX}).
							</p>
						</div>
						<Input
							type="number"
							min={MAX_TURNS_MIN}
							max={MAX_TURNS_MAX}
							class="w-28 text-xs"
							value={maxTurnsDraft}
							oninput={(e) => (maxTurnsDraft = (e.currentTarget as HTMLInputElement).value)}
							onblur={commitMaxTurns}
							onkeydown={(e) => { if (e.key === 'Enter') commitMaxTurns(); }}
						/>
					</div>

					<!-- AI status indicator -->
					<div class="status-line">
						{#if aiStatusLoading}
							<Loader2 size={11} weight="regular" class="motion-essential-spin text-text-muted" />
							<span class="status-line-text">Checking status…</span>
						{:else if aiConfigured}
							<span class="status-line-dot status-line-dot--success" aria-hidden="true"></span>
							<span class="status-line-text">AI configured and ready</span>
						{:else}
							<span class="status-line-dot status-line-dot--warning" aria-hidden="true"></span>
							<span class="status-line-text">AI not configured</span>
						{/if}
					</div>
				</div>
			</section>

			<!-- Project Recap -->
			<section id="section-recap" class="settings-section">
				<h2 class="section-head-title">Project Recap</h2>

				<div class="settings-subgroup">
					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Recap agent</p>
							<p class="settings-row-hint">
								Which agent generates daily and weekly project recaps. Auto follows your main agent.
							</p>
						</div>
						<Select.Root
							type="single"
							value={getSettings()?.recap?.agent ?? 'auto'}
							onValueChange={(v) => {
								if (!v) return;
								const next = v as RecapAgentChoice;
								const currentRecap = getSettings()?.recap;
								void updateSettings({
									recap: {
										enabled: currentRecap?.enabled ?? true,
										dailyEnabled: currentRecap?.dailyEnabled ?? true,
										weeklyEnabled: currentRecap?.weeklyEnabled ?? true,
										agent: next,
									},
								});
							}}
						>
							<Select.Trigger class="w-44 shrink-0 truncate text-xs">
								{recapAgentOptions.find((o) => o.value === (getSettings()?.recap?.agent ?? 'auto'))?.label ?? 'Auto'}
							</Select.Trigger>
							<Select.Content>
								{#each recapAgentOptions as opt (opt.value)}
									<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
			</section>

			<!-- Team Cache -->
			<section id="section-cache" class="settings-section">
				<h2 class="section-head-title">Team Cache</h2>

				<p class="section-blurb">
					Share walkthrough results with your team via a Google Cloud Storage bucket.
					When enabled, teammates who open a PR you've already reviewed hydrate instantly
					instead of re-running the agent.
				</p>

				<!-- Master switch -->
				<div class="settings-subgroup">
					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Enable remote cache</p>
							<p class="settings-row-hint">
								Off by default. Master switch — when disabled, no probes, uploads, or
								downloads happen.
							</p>
						</div>
						<Switch
							checked={getSettings()?.cache?.enabled ?? false}
							onCheckedChange={(v) => {
								void updateSettings({ cache: { enabled: v } });
							}}
							aria-label="Enable remote cache"
						/>
					</div>
				</div>

				<!-- Connection details -->
				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Connection</h3>

					<div class="settings-field">
						<label class="settings-field-label" for="cache-bucket">GCS bucket name</label>
						<Input
							id="cache-bucket"
							type="text"
							placeholder="my-team-revv-cache"
							value={getSettings()?.cache?.bucket ?? ''}
							oninput={(e) => {
								void updateSettings({
									cache: { bucket: (e.target as HTMLInputElement).value },
								});
							}}
						/>
					</div>

					<!-- ADC status -->
					<div class="settings-field">
						{#if adcStatus === null}
							<div class="flex items-center gap-2">
								<Loader2 size={12} weight="regular" class="motion-essential-spin text-text-muted" />
								<span class="text-xs text-text-muted">Checking credentials…</span>
							</div>
						{:else if adcStatus.available}
							<div class="flex items-center gap-2">
								<span class="status-line-dot status-line-dot--success" aria-hidden="true"></span>
								<span class="text-xs text-text-secondary">Application Default Credentials ready</span>
							</div>
						{:else if adcStatus.gcloudFound}
							<div class="flex flex-col gap-2">
								<div class="flex items-center gap-2">
									<span class="status-line-dot status-line-dot--warning" aria-hidden="true"></span>
									<span class="text-xs text-text-muted">Not signed in to Google Cloud</span>
								</div>
								<Button
									variant="outline"
									size="sm"
									onclick={startAdcLogin}
									disabled={adcPolling}
									class="w-fit"
								>
									{#if adcPolling}
										<Loader2 size={14} weight="regular" class="motion-essential-spin" />
										Waiting for sign-in…
									{:else}
										Sign in with Google Cloud
									{/if}
								</Button>
							</div>
						{:else}
							<div class="flex flex-col gap-2">
								<div class="flex items-center gap-2">
									<span class="status-line-dot status-line-dot--warning" aria-hidden="true"></span>
									<span class="text-xs text-text-muted">Google Cloud SDK not found</span>
								</div>
								<p class="settings-field-hint">
									Install the <a href="https://cloud.google.com/sdk/docs/install" target="_blank" rel="noopener noreferrer" class="text-accent underline underline-offset-2 hover:text-accent-hover">Google Cloud SDK</a>,
									then run <code>gcloud auth application-default login</code> in your terminal.
								</p>
							</div>
						{/if}
					</div>

					<div class="flex items-center gap-3 pt-1">
						<Button
							variant="outline"
							size="sm"
							onclick={testCacheConnection}
							disabled={cacheTestRunning}
						>
							{#if cacheTestRunning}
								<Loader2 size={14} weight="regular" class="motion-essential-spin" />
							{/if}
							Test connection
						</Button>
						{#if cacheTestState}
							<span
								class="probe-result"
								class:probe-result--ok={cacheTestState.healthy}
								class:probe-result--err={!cacheTestState.healthy}
							>
								{cacheTestState.detail}
							</span>
						{/if}
					</div>
				</div>

				<!-- Behavior -->
				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Behavior</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Upload completed walkthroughs</p>
							<p class="settings-row-hint">
								Push your generations to the bucket so teammates can hydrate from them.
							</p>
						</div>
						<Switch
							checked={getSettings()?.cache?.uploadsEnabled ?? true}
							onCheckedChange={(v) => {
								void updateSettings({ cache: { uploadsEnabled: v } });
							}}
							aria-label="Upload completed walkthroughs"
						/>
					</div>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Hydrate from team cache</p>
							<p class="settings-row-hint">
								On a cache hit, skip the agent and load the teammate's snapshot.
							</p>
						</div>
						<Switch
							checked={getSettings()?.cache?.downloadsEnabled ?? true}
							onCheckedChange={(v) => {
								void updateSettings({ cache: { downloadsEnabled: v } });
							}}
							aria-label="Hydrate from team cache"
						/>
					</div>
				</div>

				<!-- Signing -->
				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Signing</h3>
					<p class="settings-field-hint">
						Sign uploaded snapshots with your GitHub SSH key. On download, signatures are
						verified against the signer's published keys at
						<code>https://&lt;host&gt;/&lt;login&gt;.keys</code> and the signer must currently
						have write access to the repo.
					</p>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Verification mode</p>
							<p class="settings-row-hint">
								Strict is the default. Permissive accepts unsigned blobs with a warning.
							</p>
						</div>
						<Select.Root
							type="single"
							value={getSettings()?.cache?.signing?.mode ?? 'strict'}
							onValueChange={(v) => {
								if (v !== 'off' && v !== 'permissive' && v !== 'strict') return;
								void updateSettings({ cache: { signing: { mode: v } } });
							}}
						>
							<Select.Trigger class="w-64 text-xs">
								{signingModeOptions.find(
									(o) => o.value === (getSettings()?.cache?.signing?.mode ?? 'strict'),
								)?.label ?? 'Strict'}
							</Select.Trigger>
							<Select.Content>
								{#each signingModeOptions as opt (opt.value)}
									<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>

					<div class="settings-field">
						<label class="settings-field-label" for="cache-signing-key-path">
							SSH private key path
						</label>
						<Input
							id="cache-signing-key-path"
							type="text"
							placeholder="Auto-detect from ~/.ssh"
							value={getSettings()?.cache?.signing?.keyPath ?? ''}
							oninput={(e) => {
								void updateSettings({
									cache: {
										signing: { keyPath: (e.target as HTMLInputElement).value },
									},
								});
							}}
						/>
						<p class="settings-field-hint">
							Leave empty to auto-pick the first key in <code>~/.ssh</code> whose public
							half is on your GitHub <code>.keys</code> page. The private key is never
							read by Revv — <code>ssh-keygen</code> handles signing.
						</p>
					</div>

					<div class="settings-field">
						<label class="settings-field-label" for="cache-trusted-hosts">
							Trusted signer hosts
						</label>
						<Input
							id="cache-trusted-hosts"
							type="text"
							placeholder="github.com, acme.ghe.com"
							value={trustedHostsToText(getSettings()?.cache?.signing?.trustedSignerHosts)}
							onchange={(e) => {
								void updateSettings({
									cache: {
										signing: {
											trustedSignerHosts: parseTrustedHosts(
												(e.target as HTMLInputElement).value,
											),
										},
									},
								});
							}}
						/>
						<p class="settings-field-hint">
							Comma-separated. Blobs whose signer host is not in this list are rejected
							before any network call.
						</p>
					</div>

					<div class="flex items-center gap-3 pt-1">
						<Button
							variant="outline"
							size="sm"
							onclick={testCacheSigning}
							disabled={signingTestRunning}
						>
							{#if signingTestRunning}
								<Loader2 size={14} weight="regular" class="motion-essential-spin" />
							{/if}
							Test signing
						</Button>
						{#if signingTestState}
							<span
								class="probe-result"
								class:probe-result--ok={signingTestState.ok}
								class:probe-result--err={!signingTestState.ok}
							>
								{#if signingTestState.ok}
									Signed &amp; verified as {signingTestState.signerLogin}@{signingTestState.signerHost}
								{:else}
									{signingTestState.error}
								{/if}
							</span>
						{/if}
					</div>
				</div>
			</section>

			<!-- Preferences -->
			<section id="section-preferences" class="settings-section">
				<h2 class="section-head-title">Preferences</h2>

				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Appearance</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Theme</p>
							<p class="settings-row-hint">Light, dark, or follow system preference.</p>
						</div>
						<div class="flex items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated p-0.5 w-fit">
							{#each themeOptions as opt (opt.value)}
								<button
									type="button"
									class="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors"
									class:bg-bg-primary={getThemePreference() === opt.value}
									class:text-text-primary={getThemePreference() === opt.value}
									class:text-text-muted={getThemePreference() !== opt.value}
									onclick={() => setThemePreference(opt.value)}
								>
									<opt.icon size={11} />
									{opt.label}
								</button>
							{/each}
						</div>
					</div>

				</div>

				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Sync</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Sync interval</p>
							<p class="settings-row-hint">How often Revv polls GitHub for new PRs.</p>
						</div>
						<Select.Root
							type="single"
							value={String(getSettings()?.autoFetchInterval ?? 5)}
							onValueChange={(v) => {
								if (v) void updateSettings({ autoFetchInterval: Number(v) });
							}}
						>
							<Select.Trigger class="w-40 text-xs">
								{intervalOptions.find((o) => o.value === (getSettings()?.autoFetchInterval ?? 5))?.label ?? '5 minutes'}
							</Select.Trigger>
							<Select.Content>
								{#each intervalOptions as opt (opt.value)}
									<Select.Item value={String(opt.value)} class="text-xs">{opt.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
			</section>

			<!-- Onboarding -->
			<section id="section-onboarding" class="settings-section">
				<h2 class="section-head-title">Onboarding</h2>

				<div class="settings-subgroup">
					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Replay onboarding</p>
							<p class="settings-row-hint">Walk through the setup flow again from the beginning.</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							onclick={handleReplayOnboarding}
							disabled={replaying}
							class="flex shrink-0 items-center gap-1.5 text-xs"
						>
							{#if replaying}
								<Loader2 size={12} weight="regular" class="motion-essential-spin" />
								Starting…
							{:else}
								<RotateCcw size={12} weight="fill" />
								Replay
							{/if}
						</Button>
					</div>
				</div>
			</section>

			<!-- Updates -->
			<UpdatesSection />

		<!-- Danger Zone -->
		{#if getUser()}
				<section id="section-danger" class="settings-section danger-section">
					<h2 class="section-head-title section-head-title--danger">
						<TriangleAlert size={14} weight="fill" />
						Danger Zone
					</h2>

					<!-- Tracked repositories -->
					<div class="settings-subgroup">
						<h3 class="settings-subgroup-heading">Tracked repositories</h3>

						{#if getRepositories().length === 0}
							<p class="text-xs text-text-muted">No repositories tracked yet.</p>
						{:else}
							<ul class="repo-list" role="list">
								{#each getRepositories() as repo (repo.id)}
									<li class="repo-list-item">
										<span class="text-sm text-text-primary">{repo.fullName}</span>
										<button
											type="button"
											class="repo-delete-btn"
											disabled={removingRepoId === repo.id}
											onclick={() => (repoPendingDelete = repo)}
											aria-label="Remove {repo.fullName}"
										>
											{#if removingRepoId === repo.id}
												<Loader2 size={12} weight="regular" class="motion-essential-spin" />
											{:else}
												<Trash2 size={12} weight="fill" />
											{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<!-- Account removal -->
					<div class="settings-subgroup">
						<h3 class="settings-subgroup-heading">Account</h3>

						<div class="settings-row">
							<div class="settings-row-info">
								<p class="settings-row-label">Remove account</p>
								<p class="settings-row-hint">
									Permanently deletes your account and all local data. This cannot be undone.
								</p>
							</div>
							{#if !showDeleteConfirm}
								<Button
									variant="destructive"
									size="sm"
									onclick={() => (showDeleteConfirm = true)}
									class="flex shrink-0 items-center gap-1.5 text-xs"
								>
									<TriangleAlert size={12} weight="fill" />
									Remove account
								</Button>
							{:else}
								<div class="flex items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										onclick={() => (showDeleteConfirm = false)}
										disabled={deleting}
										class="text-xs text-text-muted"
									>
										Cancel
									</Button>
									<Button
										variant="destructive"
										size="sm"
										onclick={handleRemoveAccount}
										disabled={deleting}
										class="flex items-center gap-1.5 text-xs"
									>
										{#if deleting}
											<Loader2 size={12} weight="regular" class="motion-essential-spin" />
											Removing…
										{:else}
											<TriangleAlert size={12} weight="fill" />
											Confirm remove
										{/if}
									</Button>
								</div>
							{/if}
						</div>

						{#if deleteError}
							<p class="mt-2 text-xs text-danger">{deleteError}</p>
						{/if}
					</div>
				</section>
			{/if}
				<!-- Spacer so the last section can scroll fully to the top -->
				<div aria-hidden="true" style="min-height: 50vh; flex-shrink: 0;"></div>
			</div>
		</DialogPrimitive.Content>
	</Dialog.Portal>
</DialogPrimitive.Root>

<RepoDeleteConfirm
	repo={repoPendingDelete}
	open={repoPendingDelete !== null}
	deleting={repoPendingDelete ? removingRepoId === repoPendingDelete.id : false}
	onOpenChange={(nextOpen) => {
		if (!nextOpen && (!repoPendingDelete || removingRepoId !== repoPendingDelete.id)) {
			repoPendingDelete = null;
		}
	}}
	onConfirm={() => {
		if (repoPendingDelete) void handleDeleteRepo(repoPendingDelete.id);
	}}
/>

<style>
	@keyframes settings-modal-in {
		0% {
			opacity: 0;
			scale: 0.97;
			translate: 0 10px;
		}
		100% {
			opacity: 1;
			scale: 1;
			translate: 0 0;
		}
	}

	:global(.settings-modal) {
		position: fixed !important;
		top: 50% !important;
		left: 50% !important;
		transform: translate(-50%, -50%) !important;
		z-index: 50;
		display: flex;
		flex-direction: row;
		width: 100%;
		max-width: 1080px;
		height: 760px;
		max-height: 90vh;
		border-radius: 16px;
		overflow: hidden;
		outline: none;
		background: var(--color-bg-primary);
		backdrop-filter: blur(20px) saturate(1.4);
		-webkit-backdrop-filter: blur(20px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow:
			0 32px 80px rgba(0, 0, 0, 0.4),
			0 8px 24px rgba(0, 0, 0, 0.18),
			0 0 0 1px rgba(255, 255, 255, 0.02),
			inset 0 0.5px 0 0 rgba(255, 255, 255, 0.08);
	}

	:global(.settings-modal[data-state='open']) {
		animation: settings-modal-in var(--duration-slow) var(--ease-out-expo) both;
	}

	/* ── Left sidebar ── */
	.settings-sidebar {
		display: flex;
		flex-direction: column;
		width: 220px;
		flex-shrink: 0;
		border-right: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
		padding: 0;
		overflow: hidden;
	}

	.settings-sidebar-header {
		display: flex;
		align-items: center;
		padding: 22px 20px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.settings-title {
		font-family: "Newsreader", Georgia, serif;
		font-size: 22px;
		font-weight: 500;
		letter-spacing: -0.015em;
		line-height: 1;
		color: var(--color-text-primary);
	}

	.settings-nav {
		flex: 1;
		list-style: none;
		margin: 0;
		padding: 14px 8px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		overflow-y: auto;
	}

	.settings-nav-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 12px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		text-align: left;
		position: relative;
		transition:
			color var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo);
	}

	.settings-nav-item::before {
		content: "";
		position: absolute;
		left: -8px;
		top: 50%;
		transform: translateY(-50%) scaleY(0);
		width: 2px;
		height: 18px;
		background: var(--color-accent);
		border-radius: 0 2px 2px 0;
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	:global(.settings-nav-icon) {
		flex-shrink: 0;
		opacity: 0.85;
	}

	.settings-nav-label {
		font-size: 13px;
	}

	.settings-nav-item:hover {
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
	}

	.settings-nav-item--active {
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
	}

	.settings-nav-item--active::before {
		transform: translateY(-50%) scaleY(1);
	}

	.settings-nav-item--danger:hover {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
	}

	.settings-nav-item--danger.settings-nav-item--active {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
	}

	.settings-nav-item--danger.settings-nav-item--active::before {
		background: var(--color-danger);
	}

	.settings-sidebar-user {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 20px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.settings-sidebar-avatar {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.settings-sidebar-avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
	}

	.settings-sidebar-username {
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	/* ── Right content area ── */
	.settings-content {
		flex: 1;
		overflow-y: auto;
		position: relative;
		padding: 0;
		scroll-behavior: smooth;
		background: var(--color-bg-secondary);
	}

	.section-head-title--danger {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--color-danger);
	}

	.settings-subgroup-heading {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-secondary);
		letter-spacing: -0.005em;
	}

	/* Free-floating descriptive paragraph under a section heading */
	.section-blurb {
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-muted);
		max-width: 64ch;
		margin-bottom: 4px;
	}

	/* Stacked field: label above, input below (full width) */
	.settings-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.settings-field-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.settings-field-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.45;
	}

	/* ── Status line (AI status indicator) ── */
	.status-line {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.status-line-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-line-dot--success {
		background: var(--color-success);
	}

	.status-line-dot--warning {
		background: var(--color-warning);
	}

	.provider-status-action {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	.provider-warning {
		margin-top: 6px;
		display: flex;
		align-items: flex-start;
		gap: 6px;
		max-width: 440px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--color-warning);
	}

	.provider-setup-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
	}

	.provider-setup-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-primary);
	}

	.provider-setup-panel--error {
		border-color: color-mix(in srgb, var(--color-danger) 32%, var(--color-border-subtle));
	}

	.provider-setup-heading {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.provider-install-log {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 132px;
		overflow: auto;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 10.5px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.provider-install-log-line {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.provider-install-log-line--muted {
		color: var(--color-text-muted);
	}

	.provider-install-log-line--error {
		color: var(--color-danger);
	}

	.provider-manual-login {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.provider-manual-login code {
		padding: 4px 6px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 6px;
		background: var(--color-bg-primary);
		color: var(--color-text-secondary);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	}

	.provider-login-terminal {
		--ob-bg: var(--color-bg-secondary);
		--ob-border: var(--color-border-subtle);
		--ob-border-btn: var(--color-border);
		--ob-error: var(--color-danger);
		--ob-hover-subtle: var(--color-bg-primary);
		--ob-row-highlight: color-mix(in srgb, var(--color-accent) 14%, transparent);
		--ob-text: var(--color-text-primary);
		--ob-text-body: var(--color-text-secondary);
		--ob-text-dimmed: var(--color-text-muted);
		--ob-text-heading: var(--color-text-primary);
		--ob-text-italic: var(--color-accent);
		--ob-text-label: var(--color-danger);
		--ob-text-muted: var(--color-text-muted);
		padding: 12px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-primary);
	}

	/* ── Probe result (test connection feedback) ── */
	.probe-result {
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.probe-result--ok {
		color: var(--color-success);
	}

	.probe-result--err {
		color: var(--color-danger);
	}

	/* ── Settings-scoped input refinements ── */

	/* Select triggers: borderless, subtle bg, smaller text */
	:global(.settings-modal [data-slot="select-trigger"]) {
		border: 1px solid transparent;
		background: var(--color-bg-primary);
		font-size: 13px;
		height: 34px;
		border-radius: 8px;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		transition:
			background-color var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo);
	}

	:global(.settings-modal [data-slot="select-trigger"]:hover) {
		background: var(--color-bg-elevated);
		border-color: var(--color-border);
	}

	:global(.settings-modal [data-slot="select-trigger"]:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 15%, transparent);
	}

	/* Inputs: match the select style */
	:global(.settings-modal [data-slot="input"]) {
		border: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
		font-size: 13px;
		height: 34px;
		border-radius: 8px;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		text-align: left;
		transition:
			background-color var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo);
	}

	:global(.settings-modal [data-slot="input"]:hover) {
		border-color: var(--color-border);
	}

	:global(.settings-modal [data-slot="input"]:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 15%, transparent);
		background: var(--color-bg-primary);
	}

	/* Number inputs get centered, tabular numerals (Max turns, etc.) */
	:global(.settings-modal [data-slot="input"][type="number"]) {
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	/* Textarea: match input visuals */
	:global(.settings-modal textarea.settings-textarea) {
		width: 100%;
		border: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
		font-size: 12px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 10px 12px;
		border-radius: 8px;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		color: var(--color-text-primary);
		resize: vertical;
		transition:
			background-color var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo);
	}

	:global(.settings-modal textarea.settings-textarea:hover) {
		border-color: var(--color-border);
	}

	:global(.settings-modal textarea.settings-textarea:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 15%, transparent);
		outline: none;
	}

	:global(.settings-modal textarea.settings-textarea::placeholder) {
		color: var(--color-text-muted);
	}

	/* Hide number input spinners for a cleaner look */
	:global(.settings-modal [data-slot="input"]::-webkit-inner-spin-button),
	:global(.settings-modal [data-slot="input"]::-webkit-outer-spin-button) {
		-webkit-appearance: none;
		margin: 0;
	}

	:global(.settings-modal [data-slot="input"][type="number"]) {
		-moz-appearance: textfield;
		appearance: textfield;
	}

	/* ── Danger Zone ── */
	.danger-section {
		border-bottom: none;
	}

	.repo-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.repo-list-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.repo-list-item:first-child {
		border-top: 1px solid var(--color-border-subtle);
	}

	.repo-delete-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			color var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo);
	}

	.repo-delete-btn:hover:not(:disabled) {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
	}

	.repo-delete-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
