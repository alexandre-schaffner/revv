<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import GithubLogo from "phosphor-svelte/lib/GithubLogo";
import Spinner from "phosphor-svelte/lib/Spinner";
import {
  cancelSignIn,
  getDeviceFlow,
  getError,
  getIsLoading,
  signIn,
} from "$lib/stores/auth.svelte";

const error = $derived(getError());
const deviceFlow = $derived(getDeviceFlow());
const isLoading = $derived(getIsLoading());

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
				class="ml-1 cursor-pointer rounded p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
				aria-label="Copy code"
			>
				{#if copied}
					<Check class="h-4 w-4 text-success" />
				{:else}
					<Copy class="h-4 w-4" />
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
			class="cursor-pointer text-xs text-text-muted underline hover:text-text-secondary"
			onclick={cancelSignIn}
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
			class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
			onclick={() => void signIn()}
			disabled={isLoading}
		>
			{#if isLoading}
				<Spinner class="h-4 w-4 motion-essential-spin" />
			{:else}
				<GithubLogo class="h-4 w-4" />
			{/if}
			Sign in with GitHub
		</button>
	</div>
{/if}
