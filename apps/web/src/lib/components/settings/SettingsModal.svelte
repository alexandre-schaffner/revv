<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		Monitor,
		Sun,
		Moon,
		Loader2,
		ExternalLink,
		Download,
		User,
		Cpu,
		SlidersHorizontal,
		RotateCcw,
		X,
		Trash2,
		TriangleAlert,
	} from '@lucide/svelte';
	import { getCommitHash } from '$lib/updater/client';
	import { runCheck as runUpdaterCheck } from '$lib/updater/service';
	import { isTauri } from '$lib/utils/platform';
	import { getUser, signOut, resetOnboarding, removeAccount } from '$lib/stores/auth.svelte';
	import { goto } from '$app/navigation';
	import {
		getSettings,
		updateSettings,
		getAvailableModels,
		fetchModels,
	} from '$lib/stores/settings.svelte';
	import { getRepositories, deleteRepo } from '$lib/stores/prs.svelte';
	import {
		getThemePreference,
		setThemePreference,
		type ThemePreference,
	} from '$lib/stores/theme.svelte';
	import { API_BASE_URL } from '@revv/shared';
	import {
		agentSupportsThinkingEffort,
		agentSupportsContextWindow,
		getDefaultModel,
		getDefaultSuggestionsModel,
		THINKING_EFFORT_OPTIONS,
		OPUS_ONLY_EFFORTS,
	} from '$lib/constants/models';
	import { authHeaders } from '$lib/utils/session-token';
	import SignInButton from '$lib/components/auth/SignInButton.svelte';
	import type { AiAgent, ContextWindow, ThinkingEffort } from '@revv/shared';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	// ── Nav sections ──────────────────────────────────────────────────────────
	type SectionId = 'account' | 'ai' | 'preferences' | 'onboarding' | 'updates' | 'danger';

	interface NavItem {
		id: SectionId;
		label: string;
		icon: typeof User;
		tauriOnly?: boolean;
	}

	const navItems: NavItem[] = [
		{ id: 'account', label: 'Account', icon: User },
		{ id: 'ai', label: 'AI Configuration', icon: Cpu },
		{ id: 'preferences', label: 'Preferences', icon: SlidersHorizontal },
		{ id: 'onboarding', label: 'Onboarding', icon: RotateCcw },
		{ id: 'updates', label: 'Updates', icon: Download, tauriOnly: true },
		{ id: 'danger', label: 'Danger Zone', icon: TriangleAlert },
	];

	const runningInTauri = isTauri();
	const visibleNavItems = $derived(navItems.filter((n) => !n.tauriOnly || runningInTauri));

	let activeSection = $state<SectionId>('account');
	let contentEl = $state<HTMLElement | null>(null);

	// ── IntersectionObserver to highlight active nav ──────────────────────────
	$effect(() => {
		if (!contentEl || !open) return;

		const sectionEls = visibleNavItems
			.map((n) => contentEl!.querySelector<HTMLElement>(`#section-${n.id}`))
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
					activeSection = bestId.replace('section-', '') as SectionId;
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
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	// ── Avatar ────────────────────────────────────────────────────────────────
	let userAvatarFailed = $state(false);
	let lastAvatarUrl = $state<string | undefined>(undefined);
	$effect(() => {
		const current = getUser()?.image;
		if (current !== lastAvatarUrl) {
			lastAvatarUrl = current;
			userAvatarFailed = false;
		}
	});

	// ── Sync interval options ─────────────────────────────────────────────────
	const intervalOptions = [
		{ label: 'Disabled', value: 0 },
		{ label: '1 minute', value: 1 },
		{ label: '5 minutes', value: 5 },
		{ label: '10 minutes', value: 10 },
		{ label: '15 minutes', value: 15 },
		{ label: '30 minutes', value: 30 },
	];

	// ── AI Configuration ──────────────────────────────────────────────────────
	let aiConfigured = $state(false);
	let aiStatusLoading = $state(true);
	let modelsLoading = $state(false);
	let aiAgent = $derived((getSettings()?.aiAgent ?? 'opencode') as AiAgent);

	let modelOptions = $derived(getAvailableModels(aiAgent));
	let currentModel = $derived(getSettings()?.aiModel ?? '');
	let currentModelLabel = $derived(
		modelOptions.find((o) => o.value === currentModel)?.label ?? currentModel,
	);
	let currentSuggestionsModel = $derived(getSettings()?.aiSuggestionsModel ?? '');
	let currentSuggestionsModelLabel = $derived(
		modelOptions.find((o) => o.value === currentSuggestionsModel)?.label ?? currentSuggestionsModel,
	);
	let isOpus47 = $derived(currentModel === 'claude-opus-4-7');
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
		if (typeof current !== 'number') return;
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
			await goto('/');
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
			deleteError = e instanceof Error ? e.message : 'Failed to remove account. Please try again.';
		} finally {
			deleting = false;
		}
	}

	// ── Theme options ────────────────────────────────────────────────────────

	const CONTEXT_WINDOW_OPTIONS: { label: string; value: ContextWindow }[] = [
		{ label: '200K', value: '200k' },
		{ label: '1M', value: '1m' },
	];

	const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
		{ value: 'system', label: 'System', icon: Monitor },
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
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
								onclick={() => scrollToSection(item.id)}
								type="button"
							>
								<item.icon size={13} />
								{item.label}
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
								onerror={() => (userAvatarFailed = true)}
							/>
						{:else}
							<span class="settings-sidebar-avatar settings-sidebar-avatar--fallback" aria-hidden="true">
								<User size={11} />
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
					<X size={14} />
				</Button>

				<!-- Account -->
				<section id="section-account" class="settings-section">
					<h2 class="settings-section-heading">Account</h2>
					{#if getUser()}
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								{#if getUser()?.image && !userAvatarFailed}
									<img
										src={getUser()?.image}
										alt={getUser()?.name}
										class="h-9 w-9 rounded-full"
										referrerpolicy="no-referrer"
										onerror={() => (userAvatarFailed = true)}
									/>
								{:else}
									<div class="flex h-9 w-9 items-center justify-center rounded-full bg-bg-elevated text-sm font-medium text-text-secondary">
										{getUser()?.name[0]?.toUpperCase() ?? '?'}
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
								<ExternalLink size={10} />
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
				<h2 class="settings-section-heading">AI Configuration</h2>
				<div class="space-y-5">
			<!-- Agent selector -->
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-sm text-text-primary">Agent</p>
					<p class="text-xs text-text-muted">Which AI agent powers code reviews.</p>
				</div>
				<Select.Root
					type="single"
					value={aiAgent}
					onValueChange={(v) => {
						if (!v) return;
						const newAgent = v as AiAgent;
						// Kick a model-list fetch so the dropdowns below
						// populate immediately without needing a manual refresh.
						void loadModels(newAgent);
						// Mirror AgentSelector: cascade both model fields so
						// they stay valid for the new agent. Without this,
						// aiModel and aiSuggestionsModel keep the old agent's
						// catalog IDs — triggers show raw IDs matching nothing
						// and the server may call the wrong provider.
						const cached = getAvailableModels(newAgent);
						const fallback = getDefaultModel(newAgent);
						const pickedModel =
							cached.length > 0
								? (cached.find((m) => m.value === fallback)?.value ?? cached[0]!.value)
								: fallback;
						void updateSettings({
							aiAgent: newAgent,
							aiModel: pickedModel,
							aiSuggestionsModel: getDefaultSuggestionsModel(newAgent),
						});
					}}
				>
					<Select.Trigger class="w-36 text-xs">
						{aiAgent === 'opencode' ? 'opencode' : 'Claude SDK'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="opencode" class="text-xs">opencode</Select.Item>
						<Select.Item value="claude" class="text-xs">Claude SDK</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			<!-- Model selector -->
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-sm text-text-primary">Model</p>
					<p class="text-xs text-text-muted">The model used for generating reviews.</p>
				</div>
				<div class="flex items-center gap-2">
					<Select.Root
						type="single"
						value={currentModel}
						onValueChange={(v) => {
							if (v) void updateSettings({ aiModel: v });
						}}
					>
						<Select.Trigger class="w-48 text-xs truncate">
							{currentModelLabel || 'Select model…'}
						</Select.Trigger>
						<Select.Content>
							{#each modelOptions as opt (opt.value)}
								<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => loadModels(aiAgent)}
						disabled={modelsLoading}
						aria-label="Refresh models"
					>
						<Loader2 size={12} class={modelsLoading ? 'animate-spin' : ''} />
					</Button>
				</div>
			</div>

			<!-- Suggestions model selector -->
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-sm text-text-primary">Suggestions model</p>
					<p class="text-xs text-text-muted">
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
					<Select.Trigger class="w-48 text-xs truncate">
						{currentSuggestionsModelLabel || 'Select model…'}
					</Select.Trigger>
					<Select.Content>
						{#each modelOptions as opt (opt.value)}
							<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<!-- Thinking effort (agent-dependent) -->
			{#if showThinkingEffort}
				<div class="flex items-center justify-between gap-4">
					<div>
						<p class="text-sm text-text-primary">Thinking effort</p>
						<p class="text-xs text-text-muted">How much reasoning budget the model uses.</p>
					</div>
					<Select.Root
						type="single"
						value={getSettings()?.aiThinkingEffort ?? 'auto'}
						onValueChange={(v) => {
							if (v) void updateSettings({ aiThinkingEffort: v as ThinkingEffort });
						}}
					>
						<Select.Trigger class="w-36 text-xs">
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

			<!-- Context window (agent-dependent) -->
			{#if showContextWindow}
				<div class="flex items-center justify-between gap-4">
					<div>
						<p class="text-sm text-text-primary">Context window</p>
						<p class="text-xs text-text-muted">Maximum context fed to the model per review.</p>
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

			<!-- Max turns -->
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-sm text-text-primary">Max turns</p>
					<p class="text-xs text-text-muted">
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
					<div class="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2">
						{#if aiStatusLoading}
							<Loader2 size={12} class="animate-spin text-text-muted" />
							<p class="text-xs text-text-muted">Checking AI status…</p>
						{:else if aiConfigured}
							<span class="h-2 w-2 rounded-full bg-green-500 shrink-0"></span>
							<p class="text-xs text-text-secondary">AI is configured and ready.</p>
						{:else}
							<span class="h-2 w-2 rounded-full bg-yellow-500 shrink-0"></span>
							<p class="text-xs text-text-secondary">AI is not yet configured.</p>
						{/if}
					</div>
				</div>
			</section>

			<!-- Preferences -->
			<section id="section-preferences" class="settings-section">
				<h2 class="settings-section-heading">Preferences</h2>
				<div class="space-y-5">
			<!-- Theme -->
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-sm text-text-primary">Theme</p>
					<p class="text-xs text-text-muted">Light, dark, or follow system preference.</p>
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

			<!-- Sync interval -->
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-sm text-text-primary">Sync interval</p>
					<p class="text-xs text-text-muted">How often Revv polls GitHub for new PRs.</p>
				</div>
				<Select.Root
					type="single"
					value={String(getSettings()?.autoFetchInterval ?? 5)}
					onValueChange={(v) => {
						if (v) void updateSettings({ autoFetchInterval: Number(v) });
					}}
				>
					<Select.Trigger class="w-36 text-xs">
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
				<h2 class="settings-section-heading">Onboarding</h2>
				<div class="flex items-center justify-between gap-4">
					<div>
						<p class="text-sm text-text-primary">Replay onboarding</p>
						<p class="text-xs text-text-muted">Walk through the setup flow again from the beginning.</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onclick={handleReplayOnboarding}
						disabled={replaying}
						class="flex shrink-0 items-center gap-1.5 text-xs"
					>
						{#if replaying}
							<Loader2 size={12} class="animate-spin" />
							Starting…
						{:else}
							<RotateCcw size={12} />
							Replay
						{/if}
					</Button>
				</div>
			</section>

			<!-- Updates (Tauri only) -->
				{#if runningInTauri}
					<section id="section-updates" class="settings-section">
						<h2 class="settings-section-heading">Updates</h2>
						<div class="space-y-4">
							<div class="flex items-center justify-between">
								<div>
									<p class="text-sm text-text-primary">Current build</p>
									<p class="text-xs text-text-muted">Git commit snapshotted when this build was produced.</p>
								</div>
								<span class="font-mono text-sm text-text-secondary">{commitHash}</span>
							</div>
							<div class="border-t border-border-subtle"></div>
							<div class="flex items-center justify-between">
								<div>
									<p class="text-sm text-text-primary">Check for updates now</p>
									<p class="text-xs text-text-muted">Revv checks automatically every hour.</p>
								</div>
								<Button
									variant="outline"
									size="sm"
									onclick={handleCheckNow}
									disabled={checking}
									class="flex items-center gap-1.5 text-xs hover:border-accent hover:text-text-primary"
								>
									{#if checking}
										<Loader2 size={12} class="animate-spin" />
										Checking…
									{:else}
										<Download size={12} />
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
					<h2 class="settings-section-heading danger-heading">
						<TriangleAlert size={11} />
						Danger Zone
					</h2>

					<!-- Tracked repositories -->
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
											<Loader2 size={12} class="animate-spin" />
										{:else}
											<Trash2 size={12} />
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/if}

					<!-- Separator -->
					<div class="border-t border-border-subtle mt-4 pt-4"></div>

					<!-- Remove account -->
					<div class="flex items-center justify-between gap-4">
						<div>
							<p class="text-sm text-text-primary">Remove account</p>
							<p class="text-xs text-text-muted mt-0.5">
								Permanently deletes your account and all local data. This cannot be undone.
							</p>
						</div>
						{#if !showDeleteConfirm}
							<Button
								variant="outline"
								size="sm"
								onclick={() => (showDeleteConfirm = true)}
								class="flex shrink-0 items-center gap-1.5 text-xs border-danger/30 text-danger hover:bg-danger/10 hover:border-danger"
							>
								<TriangleAlert size={12} />
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
									variant="outline"
									size="sm"
									onclick={handleRemoveAccount}
									disabled={deleting}
									class="flex items-center gap-1.5 text-xs bg-danger/10 border-danger text-danger hover:bg-danger/20"
								>
									{#if deleting}
										<Loader2 size={12} class="animate-spin" />
										Removing…
									{:else}
										<TriangleAlert size={12} />
										Confirm remove
									{/if}
								</Button>
							</div>
						{/if}
					</div>
					{#if deleteError}
						<p class="mt-2 text-xs text-danger">{deleteError}</p>
					{/if}

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
		max-width: 920px;
		height: 640px;
		max-height: 85vh;
		border-radius: 14px;
		overflow: hidden;
		outline: none;
		background: var(--color-bg-primary);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow:
			0 24px 64px rgba(0, 0, 0, 0.35),
			0 4px 16px rgba(0, 0, 0, 0.2),
			inset 0 0.5px 0 0 rgba(255, 255, 255, 0.06);
	}

	:global(.settings-modal[data-state='open']) {
		animation: settings-modal-in var(--duration-slow) var(--ease-out-expo) both;
	}

	/* ── Left sidebar ── */
	.settings-sidebar {
		display: flex;
		flex-direction: column;
		width: 192px;
		flex-shrink: 0;
		border-right: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
		padding: 0;
		overflow: hidden;
	}

	.settings-sidebar-header {
		padding: 20px 16px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.settings-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.01em;
	}

	.settings-nav {
		flex: 1;
		list-style: none;
		margin: 0;
		padding: 10px 8px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
	}

	.settings-nav-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 10px;
		border: none;
		border-left: 2px solid transparent;
		border-radius: 0 6px 6px 0;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		text-align: left;
		transition:
			color var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo);
	}

	.settings-nav-item:hover {
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
	}

	.settings-nav-item--active {
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
		border-left-color: var(--color-accent);
	}

	.settings-sidebar-user {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.settings-sidebar-avatar {
		width: 20px;
		height: 20px;
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
		font-size: 11px;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		padding: 24px 28px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.settings-section-heading {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--color-text-muted);
		margin-bottom: 16px;
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

	/* Number input: match the select style */
	:global(.settings-modal [data-slot="input"]) {
		border: 1px solid transparent;
		background: var(--color-bg-primary);
		font-size: 13px;
		height: 34px;
		border-radius: 8px;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		text-align: center;
		font-variant-numeric: tabular-nums;
		transition:
			background-color var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo);
	}

	:global(.settings-modal [data-slot="input"]:hover) {
		background: var(--color-bg-elevated);
		border-color: var(--color-border);
	}

	:global(.settings-modal [data-slot="input"]:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 15%, transparent);
		background: var(--color-bg-primary);
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

	.danger-heading {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--color-danger);
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
