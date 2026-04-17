<script lang="ts">
	import * as auth from '$lib/stores/auth.svelte';

	const error = $derived(auth.getError());
	const deviceFlow = $derived(auth.getDeviceFlow());
	const isLoading = $derived(auth.getIsLoading());

	let copied = $state(false);

	async function copyCode() {
		if (!deviceFlow) return;
		await navigator.clipboard.writeText(deviceFlow.userCode);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

{#if deviceFlow}
	<div class="flex flex-col items-center gap-4 text-center">
		<p class="text-sm text-text-secondary">Enter this code on GitHub:</p>
		<div class="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-6 py-3">
			<span class="font-mono text-2xl font-bold tracking-widest text-text-primary"
				>{deviceFlow.userCode}</span
			>
			<button
				onclick={copyCode}
				class="ml-1 rounded p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
				aria-label="Copy code"
			>
				{#if copied}
					<svg
						class="h-4 w-4 text-success"
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				{:else}
					<svg
						class="h-4 w-4"
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
					</svg>
				{/if}
			</button>
		</div>
		<a
			href={deviceFlow.verificationUri}
			target="_blank"
			rel="noopener noreferrer"
			class="text-xs text-accent hover:underline"
		>
			{deviceFlow.verificationUri}
		</a>
		<p class="text-xs text-text-muted">Waiting for authorization…</p>
		<button
			class="text-xs text-text-muted underline hover:text-text-secondary"
			onclick={auth.cancelSignIn}
		>
			Cancel
		</button>
	</div>
{:else}
	<div class="flex flex-col items-center gap-3">
		{#if error}
			<p class="text-sm text-danger">{error}</p>
		{/if}
		<button
			class="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
			onclick={auth.signIn}
			disabled={isLoading}
		>
			{#if isLoading}
				<svg
					class="h-4 w-4 animate-spin"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
				>
					<circle
						class="opacity-25"
						cx="12"
						cy="12"
						r="10"
						stroke="currentColor"
						stroke-width="4"
					></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
					></path>
				</svg>
			{:else}
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="currentColor"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
					/>
				</svg>
			{/if}
			Sign in with GitHub
		</button>
	</div>
{/if}
