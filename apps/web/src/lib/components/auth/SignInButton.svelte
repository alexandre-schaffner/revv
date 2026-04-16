<script lang="ts">
	import * as auth from '$lib/stores/auth.svelte';
	import { isTauri } from '$lib/utils/platform';

	const phase = $derived(auth.getPhase());
	const error = $derived(auth.getError());
	const userCode = $derived(auth.getUserCode());
	const verificationUri = $derived(auth.getVerificationUri());

	let copied = $state(false);

	async function copyCode() {
		if (!userCode) return;
		await navigator.clipboard.writeText(userCode);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	async function openGitHub() {
		if (!verificationUri) return;
		try {
			if (isTauri()) {
				const { openUrl } = await import('@tauri-apps/plugin-opener');
				await openUrl(verificationUri);
			} else {
				window.open(verificationUri, '_blank');
			}
		} catch {
			// best-effort
		}
	}
</script>

{#if phase === 'idle'}
	<div class="flex flex-col items-center gap-3">
		{#if error}
			<p class="text-sm text-danger">{error}</p>
		{/if}
		<button
			class="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
			onclick={() => auth.signIn()}
		>
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
			</svg>
			Sign in with GitHub
		</button>
	</div>
{:else if phase === 'waiting'}
	<div class="flex flex-col items-center gap-4">
		<div class="flex items-center gap-2 text-sm text-text-muted">
			<svg class="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
			</svg>
			Requesting device code...
		</div>
	</div>
{:else if phase === 'code-ready'}
	<div class="flex flex-col items-center gap-5">
		<div class="flex flex-col items-center gap-2 text-center">
			<p class="text-sm text-text-muted">Enter this code on GitHub to authorize:</p>
			<div class="flex items-center gap-3">
				<span class="font-mono text-2xl font-bold tracking-widest text-text-primary">{userCode}</span>
				<button
					class="rounded-md border border-border bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary"
					onclick={copyCode}
					title="Copy code"
				>
					{copied ? 'Copied!' : 'Copy'}
				</button>
			</div>
		</div>

		<button
			class="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
			onclick={openGitHub}
		>
			Open GitHub
			<svg class="h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd"/>
				<path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd"/>
			</svg>
		</button>

		<div class="flex items-center gap-2 text-xs text-text-muted animate-pulse">
			<svg class="h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clip-rule="evenodd"/>
			</svg>
			Waiting for authorization…
		</div>

		<button
			class="text-xs text-text-muted underline transition-colors hover:text-text-secondary"
			onclick={() => auth.cancelSignIn()}
		>
			Cancel
		</button>
	</div>
{/if}
