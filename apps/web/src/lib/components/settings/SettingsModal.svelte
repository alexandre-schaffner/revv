<script lang="ts">
import CalendarClock from "phosphor-svelte/lib/CalendarCheck";
import Cloud from "phosphor-svelte/lib/Cloud";
import Cpu from "phosphor-svelte/lib/Cpu";
import Download from "phosphor-svelte/lib/Download";
import ExternalLink from "phosphor-svelte/lib/ArrowSquareOut";
import Loader2 from "phosphor-svelte/lib/Spinner";
import Monitor from "phosphor-svelte/lib/Desktop";
import Moon from "phosphor-svelte/lib/Moon";
import RefreshCw from "phosphor-svelte/lib/ArrowsClockwise";
import RotateCcw from "phosphor-svelte/lib/ArrowCounterClockwise";
import SlidersHorizontal from "phosphor-svelte/lib/SlidersHorizontal";
import Sun from "phosphor-svelte/lib/Sun";
import Trash2 from "phosphor-svelte/lib/Trash";
import TriangleAlert from "phosphor-svelte/lib/Warning";
import User from "phosphor-svelte/lib/User";
import X from "phosphor-svelte/lib/X";
import type { AiAgent, ContextWindow, RecapAgentChoice, ThinkingEffort } from "@revv/shared";
import { Dialog as DialogPrimitive } from "bits-ui";
import { SvelteMap } from "svelte/reactivity";
import { goto } from "$app/navigation";
import { API_BASE_URL } from "$lib/api/base-url";
import SignInButton from "$lib/components/auth/SignInButton.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Switch } from "$lib/components/ui/switch";
import {
  agentSupportsContextWindow,
  agentSupportsThinkingEffort,
  OPUS_ONLY_EFFORTS,
  THINKING_EFFORT_OPTIONS,
} from "$lib/constants/models";
import { getUser, removeAccount, resetOnboarding, signOut } from "$lib/stores/auth.svelte";
import { deleteRepo, getRepositories } from "$lib/stores/prs.svelte";
import {
  cascadeAgentChange,
  fetchModels,
  getAvailableModels,
  getSettings,
  updateSettings,
} from "$lib/stores/settings.svelte";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";
import { getCommitHash } from "$lib/updater/client";
import { runCheck as runUpdaterCheck } from "$lib/updater/service";
import { isTauri } from "$lib/utils/platform";
import { authHeaders } from "$lib/utils/session-token";

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
  tauriOnly?: boolean;
}

const navItems: NavItem[] = [
  { id: "account", label: "Account", icon: User },
  { id: "ai", label: "AI Configuration", icon: Cpu },
  { id: "recap", label: "Project Recap", icon: CalendarClock },
  { id: "cache", label: "Team Cache", icon: Cloud },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "onboarding", label: "Onboarding", icon: RotateCcw },
  { id: "updates", label: "Updates", icon: Download, tauriOnly: true },
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

// ── Recap agent selector options ──────────────────────────────────────────
const recapAgentOptions: { value: RecapAgentChoice; label: string }[] = [
  { value: "auto", label: "Auto (follow main agent)" },
  { value: "opencode", label: "OpenCode" },
  { value: "claude", label: "Claude SDK" },
];

const runningInTauri = isTauri();
const visibleNavItems = $derived(navItems.filter((n) => !n.tauriOnly || runningInTauri));

let activeSection = $state<SectionId>("account");
let contentEl = $state<HTMLElement | null>(null);

// ── IntersectionObserver to highlight active nav ──────────────────────────
$effect(() => {
  if (!contentEl || !open) return;

  const sectionEls = visibleNavItems
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
let modelsLoading = $state(false);
let aiAgent = $derived((getSettings()?.aiAgent ?? "opencode") as AiAgent);

let modelOptions = $derived(getAvailableModels(aiAgent));
let currentModel = $derived(getSettings()?.aiModel ?? "");
let currentModelLabel = $derived(
  modelOptions.find((o) => o.value === currentModel)?.label ?? currentModel,
);
let currentSuggestionsModel = $derived(getSettings()?.aiSuggestionsModel ?? "");
let currentSuggestionsModelLabel = $derived(
  modelOptions.find((o) => o.value === currentSuggestionsModel)?.label ?? currentSuggestionsModel,
);
let isOpus47 = $derived(currentModel === "claude-opus-4-7");
let showThinkingEffort = $derived(agentSupportsThinkingEffort(aiAgent));
let showContextWindow = $derived(agentSupportsContextWindow(aiAgent));
let thinkingEffortOptions = $derived(
  isOpus47
    ? THINKING_EFFORT_OPTIONS
    : THINKING_EFFORT_OPTIONS.filter((o) => !OPUS_ONLY_EFFORTS.has(o.value)),
);

$effect(() => {
  if (open) {
    fetchAiStatus();
  }
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

async function loadModels(agent: AiAgent): Promise<void> {
  modelsLoading = true;
  try {
    await fetchModels(agent);
  } finally {
    modelsLoading = false;
  }
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

// ── Updates ───────────────────────────────────────────────────────────────
let checking = $state(false);
const commitHash = getCommitHash();

async function handleCheckNow(): Promise<void> {
  checking = true;
  try {
    await runUpdaterCheck({ manual: true });
  } finally {
    checking = false;
  }
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

async function handleDeleteRepo(id: string): Promise<void> {
  removingRepoId = id;
  try {
    await deleteRepo(id);
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

const CONTEXT_WINDOW_OPTIONS: { label: string; value: ContextWindow }[] = [
  { label: "200K", value: "200k" },
  { label: "1M", value: "1m" },
];

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
					{#each visibleNavItems as item (item.id)}
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

				<!-- Agent + Model selection -->
				<div class="settings-subgroup">
					<h3 class="settings-subgroup-heading">Agent & models</h3>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Agent</p>
							<p class="settings-row-hint">Which AI agent powers code reviews.</p>
						</div>
						<Select.Root
							type="single"
							value={aiAgent}
							onValueChange={(v) => {
								if (!v) return;
								const newAgent = v as AiAgent;
								void loadModels(newAgent);
								void updateSettings(cascadeAgentChange(newAgent));
							}}
						>
							<Select.Trigger class="w-40 text-xs">
								{aiAgent === 'opencode' ? 'opencode' : 'Claude SDK'}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="opencode" class="text-xs">opencode</Select.Item>
								<Select.Item value="claude" class="text-xs">Claude SDK</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>

					<div class="settings-row">
						<div class="settings-row-info">
							<p class="settings-row-label">Review model</p>
							<p class="settings-row-hint">The model used for generating reviews.</p>
						</div>
						<div class="flex items-center gap-2">
							<Button
								variant="ghost"
								size="icon-sm"
								onclick={() => loadModels(aiAgent)}
								disabled={modelsLoading}
								aria-label="Refresh models"
							>
								<RefreshCw size={12} weight="fill" class={modelsLoading ? 'animate-spin' : ''} />
							</Button>
							<Select.Root
								type="single"
								value={currentModel}
								onValueChange={(v) => {
									if (v) void updateSettings({ aiModel: v });
								}}
							>
								<Select.Trigger class="w-52 text-xs truncate">
									{currentModelLabel || 'Select model…'}
								</Select.Trigger>
								<Select.Content>
									{#each modelOptions as opt (opt.value)}
										<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
					</div>

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

				<!-- Generation tuning -->
				{#if showThinkingEffort || showContextWindow}
					<div class="settings-subgroup">
						<h3 class="settings-subgroup-heading">Generation</h3>

						{#if showThinkingEffort}
							<div class="settings-row">
								<div class="settings-row-info">
									<p class="settings-row-label">Thinking effort</p>
									<p class="settings-row-hint">How much reasoning budget the model uses.</p>
								</div>
								<Select.Root
									type="single"
									value={getSettings()?.aiThinkingEffort ?? 'auto'}
									onValueChange={(v) => {
										if (v) void updateSettings({ aiThinkingEffort: v as ThinkingEffort });
									}}
								>
									<Select.Trigger class="w-40 text-xs">
										{thinkingEffortOptions.find((o) => o.value === (getSettings()?.aiThinkingEffort ?? 'auto'))?.label ?? 'Auto'}
									</Select.Trigger>
									<Select.Content>
										{#each thinkingEffortOptions as opt (opt.value)}
											<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
						{/if}

						{#if showContextWindow}
							<div class="settings-row">
								<div class="settings-row-info">
									<p class="settings-row-label">Context window</p>
									<p class="settings-row-hint">Maximum context fed to the model per review.</p>
								</div>
								<Select.Root
									type="single"
									value={getSettings()?.aiContextWindow ?? '200k'}
									onValueChange={(v) => {
										if (v) void updateSettings({ aiContextWindow: v as ContextWindow });
									}}
								>
									<Select.Trigger class="w-28 text-xs">
										{CONTEXT_WINDOW_OPTIONS.find((o) => o.value === (getSettings()?.aiContextWindow ?? '200k'))?.label ?? '200K'}
									</Select.Trigger>
									<Select.Content>
										{#each CONTEXT_WINDOW_OPTIONS as opt (opt.value)}
											<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
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
							<Loader2 size={11} weight="regular" class="animate-spin text-text-muted" />
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

					<div class="settings-field">
						<label class="settings-field-label" for="cache-creds-json">
							Service-account JSON
						</label>
						<textarea
							id="cache-creds-json"
							class="settings-textarea"
							rows={5}
							placeholder={`{"type":"service_account",...}`}
							value={getSettings()?.cache?.credentialsJson ?? ''}
							onchange={(e) => {
								void updateSettings({
									cache: { credentialsJson: (e.target as HTMLTextAreaElement).value },
								});
							}}
						></textarea>
						<p class="settings-field-hint">
							Stored in plaintext locally. Alternatively set a filesystem path below.
						</p>
					</div>

					<div class="settings-field">
						<label class="settings-field-label" for="cache-creds-path">
							Service-account JSON path (optional)
						</label>
						<Input
							id="cache-creds-path"
							type="text"
							placeholder="/Users/me/.config/revv/cache-sa.json"
							value={getSettings()?.cache?.credentialsPath ?? ''}
							oninput={(e) => {
								void updateSettings({
									cache: { credentialsPath: (e.target as HTMLInputElement).value },
								});
							}}
						/>
					</div>

					<div class="flex items-center gap-3 pt-1">
						<Button
							variant="outline"
							size="sm"
							onclick={testCacheConnection}
							disabled={cacheTestRunning}
						>
							{#if cacheTestRunning}
								<Loader2 size={14} weight="regular" class="animate-spin" />
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
								<Loader2 size={12} weight="regular" class="animate-spin" />
								Starting…
							{:else}
								<RotateCcw size={12} weight="fill" />
								Replay
							{/if}
						</Button>
					</div>
				</div>
			</section>

			<!-- Updates (Tauri only) -->
			{#if runningInTauri}
				<section id="section-updates" class="settings-section">
					<h2 class="section-head-title">Updates</h2>

					<div class="settings-subgroup">
						<div class="settings-row">
							<div class="settings-row-info">
								<p class="settings-row-label">Current build</p>
								<p class="settings-row-hint">Git commit snapshotted when this build was produced.</p>
							</div>
							<span class="font-mono text-xs text-text-secondary">{commitHash}</span>
						</div>

						<div class="settings-row">
							<div class="settings-row-info">
								<p class="settings-row-label">Check for updates now</p>
								<p class="settings-row-hint">Revv checks automatically every hour.</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								onclick={handleCheckNow}
								disabled={checking}
								class="flex items-center gap-1.5 text-xs hover:border-accent hover:text-text-primary"
							>
								{#if checking}
									<Loader2 size={12} weight="regular" class="animate-spin" />
									Checking…
								{:else}
									<Download size={12} weight="fill" />
									Check now
								{/if}
							</Button>
						</div>
					</div>
				</section>
			{/if}

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
											onclick={() => handleDeleteRepo(repo.id)}
											aria-label="Remove {repo.fullName}"
										>
											{#if removingRepoId === repo.id}
												<Loader2 size={12} weight="regular" class="animate-spin" />
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
											<Loader2 size={12} weight="regular" class="animate-spin" />
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

	.settings-section {
		padding: 32px 36px 28px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.section-head-title {
		font-family: "Newsreader", Georgia, serif;
		font-size: 20px;
		font-weight: 500;
		letter-spacing: -0.01em;
		line-height: 1;
		color: var(--color-text-primary);
		margin-bottom: 22px;
	}

	.section-head-title--danger {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--color-danger);
	}

	/* Sub-group inside a section (e.g. "Connection", "Behavior") */
	.settings-subgroup {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-top: 18px;
		margin-top: 18px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.settings-subgroup:first-of-type {
		padding-top: 0;
		margin-top: 0;
		border-top: none;
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

	/* Row: label/description on the left, control on the right */
	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.settings-row-info {
		min-width: 0;
		flex: 1;
	}

	.settings-row-label {
		font-size: 13px;
		color: var(--color-text-primary);
	}

	.settings-row-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		margin-top: 2px;
		line-height: 1.45;
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
