<script lang="ts">
	import { Monitor, Sun, Moon, Loader2, ArrowLeft, AlertTriangle } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { getUser, signOut } from '$lib/stores/auth.svelte';
	import { getSettings, updateSettings, getAvailableModels, fetchModels } from '$lib/stores/settings.svelte';
	import { getRepositories, deleteRepo, addRepo } from '$lib/stores/prs.svelte';
	import {
		getThemePreference,
		setThemePreference,
		type ThemePreference,
	} from '$lib/stores/theme.svelte';
	import { API_BASE_URL } from '@revv/shared';
	import { agentSupportsThinkingEffort, getDefaultModel } from '$lib/constants/models';
	import { authHeaders } from '$lib/utils/session-token';
	import SignInButton from '$lib/components/auth/SignInButton.svelte';
	import { toast } from '$lib/utils/toast';

	import type { AiAgent, ThinkingEffort } from '@revv/shared';

	const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] = [
		{ label: 'High', value: 'high' },
		{ label: 'Medium', value: 'medium' },
		{ label: 'Low', value: 'low' },
	];

	const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
		{ value: 'system', label: 'System', icon: Monitor },
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
	];

	let addRepoValue = $state('');
	let addRepoError = $state('');
	let addRepoLoading = $state(false);

	async function handleAddRepo() {
		const trimmed = addRepoValue.trim();
		if (!trimmed.includes('/')) {
			addRepoError = 'Use owner/name format';
			return;
		}
		addRepoLoading = true;
		addRepoError = '';
		try {
			await addRepo(trimmed);
			addRepoValue = '';
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to add repo';
			addRepoError = msg;
			toast.error(msg);
		} finally {
			addRepoLoading = false;
		}
	}

	const intervalOptions = [
		{ label: 'Disabled', value: 0 },
		{ label: '1 minute', value: 1 },
		{ label: '5 minutes', value: 5 },
		{ label: '10 minutes', value: 10 },
		{ label: '15 minutes', value: 15 },
		{ label: '30 minutes', value: 30 },
	];

	// --- AI Configuration state ---
	let aiConfigured = $state(false);
	let aiStatusLoading = $state(true);
	let modelsLoading = $state(false);
	let aiAgent = $derived((getSettings()?.aiAgent ?? 'opencode') as AiAgent);

	// Reactive model options and visibility based on selected agent
	let modelOptions = $derived(getAvailableModels());
	let showThinkingEffort = $derived(agentSupportsThinkingEffort(aiAgent));

	// Fetch AI status and models on mount
	$effect(() => {
		fetchAiStatus();
		void loadModels();
	});

	async function fetchAiStatus(): Promise<void> {
		aiStatusLoading = true;
		try {
			const res = await fetch(`${API_BASE_URL}/api/settings/ai-status`, {
				headers: authHeaders(),
			});
			if (res.ok) {
				const data = (await res.json()) as {
					configured: boolean;
					model: string;
				};
				aiConfigured = data.configured;
			}
		} catch {
			// Ignore — status will show as unconfigured
		} finally {
			aiStatusLoading = false;
		}
	}

	async function loadModels(): Promise<void> {
		modelsLoading = true;
		try {
			await fetchModels();
		} finally {
			modelsLoading = false;
		}
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && goto('/')} />

<div class="mx-auto max-w-2xl space-y-8 px-6 py-8">
	<div class="flex items-center gap-3">
		<button
			class="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
			onclick={() => goto('/')}
			aria-label="Back to pull requests"
			title="Back to pull requests"
		>
			<ArrowLeft size={16} />
		</button>
		<h1 class="text-lg font-semibold text-text-primary">Settings</h1>
	</div>

	<!-- GitHub Account -->
	<section class="rounded-lg border border-border bg-bg-secondary p-5">
		<h2 class="mb-4 text-sm font-semibold text-text-primary">GitHub Account</h2>
		{#if getUser()}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					{#if getUser()?.image}
						<img src={getUser()?.image} alt={getUser()?.name} class="h-9 w-9 rounded-full" />
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
				<button
					class="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-danger hover:text-danger"
					onclick={signOut}
				>
					Sign out
				</button>
			</div>
		{:else}
			<div class="flex items-center justify-between">
				<p class="text-sm text-text-muted">Not signed in</p>
				<SignInButton />
			</div>
		{/if}
	</section>

	<!-- Repositories -->
	<section class="rounded-lg border border-border bg-bg-secondary p-5">
		<h2 class="mb-4 text-sm font-semibold text-text-primary">Repositories</h2>
		{#if getUser()}

		<!-- Add repo -->
		<div class="mb-4 flex gap-2">
			<input
				class="h-8 flex-1 rounded-md border border-border bg-bg-elevated px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
				placeholder="owner/repository"
				bind:value={addRepoValue}
				onkeydown={(e) => e.key === 'Enter' && handleAddRepo()}
				disabled={addRepoLoading}
			/>
			<button
				class="rounded-md bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
				onclick={handleAddRepo}
				disabled={addRepoLoading || !addRepoValue.trim()}
			>
				{addRepoLoading ? 'Adding…' : 'Add'}
			</button>
		</div>
		{#if addRepoError}
			<p class="mb-3 text-xs text-danger">{addRepoError}</p>
		{/if}

		<!-- Repo list -->
		{#if getRepositories().length === 0}
			<p class="text-sm text-text-muted">No repositories added yet.</p>
		{:else}
			<div class="space-y-1">
				{#each getRepositories() as repo (repo.id)}
					<div class="flex items-center justify-between rounded-md bg-bg-elevated px-3 py-2">
						<div class="flex items-center gap-2">
							{#if repo.avatarUrl}
								<img src={repo.avatarUrl} alt="" class="h-4 w-4 rounded-sm" />
							{/if}
							<span class="text-sm text-text-primary">{repo.fullName}</span>
							{#if repo.cloneStatus === 'cloning'}
								<span class="flex items-center gap-1 text-[10px] text-text-muted">
									<Loader2 size={10} class="animate-spin" />
									Cloning
								</span>
							{:else if repo.cloneStatus === 'error'}
								<span class="flex items-center gap-1 text-[10px] text-amber-500" title={repo.cloneError ?? 'Clone failed'}>
									<AlertTriangle size={10} />
									Clone failed
								</span>
							{/if}
						</div>
						<button
							class="text-xs text-text-muted transition-colors hover:text-danger"
							onclick={() => deleteRepo(repo.id)}
						>
							Remove
						</button>
					</div>
				{/each}
			</div>
		{/if}

		{:else}
			<p class="text-sm text-text-muted">Sign in with GitHub to manage repositories.</p>
		{/if}
	</section>

	<!-- AI Configuration -->
	<section class="rounded-lg border border-border bg-bg-secondary p-5">
		<h2 class="mb-4 text-sm font-semibold text-text-primary">AI Configuration</h2>

		<div class="space-y-4">
			<!-- Status -->
			<div class="flex items-center gap-2">
				{#if aiStatusLoading}
					<div class="h-2 w-2 rounded-full bg-text-muted"></div>
					<span class="text-xs text-text-muted">Checking…</span>
				{:else if aiConfigured}
					<div class="h-2 w-2 rounded-full bg-emerald-500"></div>
					<span class="text-xs text-text-muted">Using {aiAgent === 'claude' ? 'Claude Code' : 'OpenCode'}</span>
				{:else}
					<div class="h-2 w-2 rounded-full bg-amber-500"></div>
					<span class="text-xs text-text-muted">CLI agent not found</span>
				{/if}
			</div>

			<!-- CLI not found notice -->
			{#if !aiStatusLoading && !aiConfigured}
				<div class="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
					<p class="text-xs font-medium text-amber-400">No CLI agent detected</p>
					<p class="mt-0.5 text-xs text-text-muted">
						Install <a href="https://opencode.ai" class="text-accent underline underline-offset-2">OpenCode</a>
						or <a href="https://claude.ai/code" class="text-accent underline underline-offset-2">Claude Code</a>
						and authenticate to enable AI features.
					</p>
				</div>
			{/if}

			<!-- CLI detected notice -->
			{#if !aiStatusLoading && aiConfigured}
				<div class="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
					<p class="text-xs font-medium text-emerald-400">{aiAgent === 'claude' ? 'Claude Code' : 'OpenCode'} detected</p>
					<p class="mt-0.5 text-xs text-text-muted">
						Using your {aiAgent === 'claude' ? 'Claude Code' : 'OpenCode'} CLI for AI-powered reviews.
					</p>
				</div>
			{/if}

			<!-- Model selector -->
			<div class="flex items-center justify-between">
				<div>
					<label class="text-sm text-text-primary" for="ai-model">Model</label>
					<p class="text-xs text-text-muted">Claude model for AI explanations</p>
				</div>
				{#if modelsLoading}
					<div class="h-8 w-40 animate-pulse rounded-md bg-bg-elevated"></div>
				{:else}
				<select
					id="ai-model"
					class="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
					value={getSettings()?.aiModel ?? 'opencode/big-pickle'}
					onchange={(e) =>
						updateSettings({ aiModel: (e.target as HTMLSelectElement).value })}
				>
				{#each modelOptions as opt}
					<option value={opt.value}>{opt.label}</option>
				{/each}
				</select>
				{/if}
			</div>

			<!-- Thinking Effort selector -->
			{#if showThinkingEffort}
				<div class="flex items-center justify-between">
					<div>
						<label class="text-sm text-text-primary" for="ai-thinking-effort">Thinking Effort</label>
						<p class="text-xs text-text-muted">Extended thinking budget for Claude</p>
					</div>
					<select
						id="ai-thinking-effort"
						class="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
						value={getSettings()?.aiThinkingEffort ?? 'medium'}
						onchange={(e) => updateSettings({ aiThinkingEffort: (e.target as HTMLSelectElement).value as ThinkingEffort })}
					>
						{#each THINKING_EFFORT_OPTIONS as opt}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>
			{/if}

			<!-- Agent selector -->
			<div class="flex items-center justify-between">
				<div>
					<label class="text-sm text-text-primary" for="ai-agent">CLI Agent</label>
					<p class="text-xs text-text-muted">Tool used for AI-powered walkthroughs</p>
				</div>
				<select
					id="ai-agent"
					class="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
					value={aiAgent}
					onchange={async (e) => {
						const newAgent = (e.target as HTMLSelectElement).value as AiAgent;
						await updateSettings({ aiAgent: newAgent, aiModel: getDefaultModel(newAgent) });
						await loadModels();
					}}
				>
					<option value="opencode">OpenCode</option>
					<option value="claude">Claude Code</option>
				</select>
			</div>
		</div>
	</section>

	<!-- Preferences -->
	<section class="rounded-lg border border-border bg-bg-secondary p-5">
		<h2 class="mb-4 text-sm font-semibold text-text-primary">Preferences</h2>
		<div class="space-y-4">
			<!-- Theme -->
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm text-text-primary">Theme</p>
					<p class="text-xs text-text-muted">Select light, dark, or match your system</p>
				</div>
				<div class="flex gap-1 rounded-lg border border-border bg-bg-elevated p-1">
					{#each themeOptions as opt (opt.value)}
						<button
							class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors
								{getThemePreference() === opt.value
									? 'bg-bg-tertiary text-text-primary shadow-sm'
									: 'text-text-muted hover:text-text-secondary'}"
							onclick={() => setThemePreference(opt.value)}
						>
							<opt.icon size={14} />
							{opt.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Divider -->
			<div class="border-t border-border-subtle"></div>

			<!-- Auto-fetch -->
			<div class="flex items-center justify-between">
				<div>
					<label class="text-sm text-text-primary" for="auto-fetch">Auto-fetch interval</label>
					<p class="text-xs text-text-muted">How often to sync PRs from GitHub</p>
				</div>
				<select
					id="auto-fetch"
					class="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
					value={getSettings()?.autoFetchInterval ?? 5}
					onchange={(e) =>
						updateSettings({ autoFetchInterval: Number((e.target as HTMLSelectElement).value) })}
				>
					{#each intervalOptions as opt}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</div>
		</div>
	</section>
</div>
