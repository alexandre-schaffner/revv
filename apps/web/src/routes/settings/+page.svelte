<script lang="ts">
	import { Monitor, Sun, Moon, Check, X, Loader2, ArrowLeft } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { getUser, signOut } from '$lib/stores/auth.svelte';
	import { getSettings, updateSettings } from '$lib/stores/settings.svelte';
	import { getRepositories, deleteRepo, addRepo } from '$lib/stores/prs.svelte';
	import {
		getThemePreference,
		setThemePreference,
		type ThemePreference,
	} from '$lib/stores/theme.svelte';
	import { API_BASE_URL } from '@rev/shared';

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
			addRepoError = e instanceof Error ? e.message : 'Failed to add repo';
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
	let aiKeyInput = $state('');
	let aiKeySaving = $state(false);
	let aiKeyStatus = $state<'idle' | 'valid' | 'invalid'>('idle');
	let aiKeyError = $state('');
	let aiConfigured = $state(false);
	let aiKeySource = $state<'settings' | 'environment' | 'none'>('none');
	let aiStatusLoading = $state(true);

	const modelOptions = [
		{ label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
		{ label: 'Claude Haiku 4', value: 'claude-haiku-4-20250414' },
	];

	function getAuthHeaders(): Record<string, string> {
		const token =
			typeof localStorage !== 'undefined' ? (localStorage.getItem('rev_session_token') ?? '') : '';
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	// Fetch AI status on mount
	$effect(() => {
		fetchAiStatus();
	});

	async function fetchAiStatus(): Promise<void> {
		aiStatusLoading = true;
		try {
			const res = await fetch(`${API_BASE_URL}/api/settings/ai-status`, {
				headers: getAuthHeaders(),
			});
			if (res.ok) {
				const data = (await res.json()) as {
					configured: boolean;
					keySource: 'settings' | 'environment' | 'none';
					model: string;
				};
				aiConfigured = data.configured;
				aiKeySource = data.keySource;
			}
		} catch {
			// Ignore — status will show as unconfigured
		} finally {
			aiStatusLoading = false;
		}
	}

	async function handleSaveAiKey(): Promise<void> {
		if (!aiKeyInput.trim()) return;
		aiKeySaving = true;
		aiKeyStatus = 'idle';
		aiKeyError = '';
		try {
			const res = await fetch(`${API_BASE_URL}/api/settings/ai-key`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
				body: JSON.stringify({ apiKey: aiKeyInput.trim() }),
			});
			const data = (await res.json()) as { configured?: boolean; error?: string };
			if (res.ok && data.configured) {
				aiKeyStatus = 'valid';
				aiConfigured = true;
				aiKeySource = 'settings';
				aiKeyInput = '';
			} else {
				aiKeyStatus = 'invalid';
				aiKeyError = data.error ?? 'Invalid API key';
			}
		} catch {
			aiKeyStatus = 'invalid';
			aiKeyError = 'Network error';
		} finally {
			aiKeySaving = false;
		}
	}

	async function handleRemoveAiKey(): Promise<void> {
		try {
			await fetch(`${API_BASE_URL}/api/settings/ai-key`, {
				method: 'DELETE',
				headers: getAuthHeaders(),
			});
			aiKeyStatus = 'idle';
			aiKeyError = '';
			// Re-fetch status — may fall back to env var
			await fetchAiStatus();
		} catch {
			// Ignore
		}
	}
</script>

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
			<p class="text-sm text-text-muted">Not connected</p>
		{/if}
	</section>

	<!-- Repositories -->
	<section class="rounded-lg border border-border bg-bg-secondary p-5">
		<h2 class="mb-4 text-sm font-semibold text-text-primary">Repositories</h2>

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
				{:else if aiConfigured && aiKeySource === 'environment'}
					<div class="h-2 w-2 rounded-full bg-emerald-500"></div>
					<span class="text-xs text-text-muted">Using system API key (ANTHROPIC_API_KEY)</span>
				{:else if aiConfigured && aiKeySource === 'settings'}
					<div class="h-2 w-2 rounded-full bg-emerald-500"></div>
					<span class="text-xs text-text-muted">API key configured</span>
				{:else}
					<div class="h-2 w-2 rounded-full bg-amber-500"></div>
					<span class="text-xs text-text-muted">No API key</span>
				{/if}
			</div>

			<!-- Environment key detected notice -->
			{#if !aiStatusLoading && aiKeySource === 'environment' && !aiConfigured}
				<!-- This case shouldn't happen (env = configured), but defensive -->
			{/if}

			{#if !aiStatusLoading && aiKeySource === 'environment'}
				<div class="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
					<p class="text-xs font-medium text-emerald-400">Detected from environment</p>
					<p class="mt-0.5 text-xs text-text-muted">
						Using the <code class="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-[10px]">ANTHROPIC_API_KEY</code> environment variable from your system (e.g. Claude Code).
						You can override it below by saving a different key.
					</p>
				</div>
			{/if}

			<!-- Provider -->
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm text-text-primary">Provider</p>
					<p class="text-xs text-text-muted">Anthropic Claude</p>
				</div>
			</div>

			<!-- API Key -->
			<div>
				<label class="mb-1.5 block text-sm text-text-primary" for="ai-key">
					{#if aiKeySource === 'environment'}
						Override API Key
					{:else}
						API Key
					{/if}
				</label>
				<div class="flex gap-2">
					<input
						id="ai-key"
						type="password"
						class="h-8 flex-1 rounded-md border border-border bg-bg-elevated px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
						placeholder={aiKeySource === 'settings' ? '••••••••••••••••' : 'sk-ant-...'}
						bind:value={aiKeyInput}
						onkeydown={(e) => e.key === 'Enter' && handleSaveAiKey()}
						disabled={aiKeySaving}
					/>
					<button
						class="flex items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
						onclick={handleSaveAiKey}
						disabled={aiKeySaving || !aiKeyInput.trim()}
					>
						{#if aiKeySaving}
							<Loader2 size={13} class="animate-spin" />
							Validating…
						{:else}
							Save
						{/if}
					</button>
				</div>
				{#if aiKeyStatus === 'valid'}
					<p class="mt-1.5 flex items-center gap-1 text-xs text-emerald-500">
						<Check size={12} />
						Key validated successfully
					</p>
				{:else if aiKeyStatus === 'invalid'}
					<p class="mt-1.5 flex items-center gap-1 text-xs text-danger">
						<X size={12} />
						{aiKeyError}
					</p>
				{/if}
			</div>

			<!-- Model selector -->
			<div class="flex items-center justify-between">
				<div>
					<label class="text-sm text-text-primary" for="ai-model">Model</label>
					<p class="text-xs text-text-muted">Claude model for AI explanations</p>
				</div>
				<select
					id="ai-model"
					class="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
					value={getSettings()?.aiModel ?? 'claude-sonnet-4-20250514'}
					onchange={(e) =>
						updateSettings({ aiModel: (e.target as HTMLSelectElement).value })}
				>
					{#each modelOptions as opt}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</div>

			<!-- Remove key (only when a saved key exists, not for env-only) -->
			{#if aiKeySource === 'settings'}
				<div class="border-t border-border-subtle pt-4">
					<button
						class="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-danger hover:text-danger"
						onclick={handleRemoveAiKey}
					>
						Remove Saved Key
					</button>
				</div>
			{/if}
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
