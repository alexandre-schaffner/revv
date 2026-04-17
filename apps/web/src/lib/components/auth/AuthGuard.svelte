<script lang="ts">
	import { getIsAuthenticated } from '$lib/stores/auth.svelte';
	import SignInButton from './SignInButton.svelte';

	let { children } = $props();
</script>

{#if getIsAuthenticated()}
	{@render children()}
{:else}
	<div class="flex h-full flex-col items-center justify-center gap-6">
		<div class="text-center">
			<div class="mb-3 flex justify-center">
				<div class="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white">
					R
				</div>
			</div>
			<h1 class="text-xl font-semibold text-text-primary">Welcome to Revv</h1>
			<p class="mt-1 text-sm text-text-muted">Connect your GitHub account to start reviewing PRs</p>
		</div>
		<SignInButton />
	</div>
{/if}
