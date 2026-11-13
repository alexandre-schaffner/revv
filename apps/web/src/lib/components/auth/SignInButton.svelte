<script lang="ts">
import GithubLogo from "phosphor-svelte/lib/GithubLogo";
import Spinner from "phosphor-svelte/lib/Spinner";
import { getDeviceFlow, getError, getIsLoading, signIn } from "$lib/stores/auth.svelte";
import DeviceCodePanel from "./DeviceCodePanel.svelte";

const error = $derived(getError());
const deviceFlow = $derived(getDeviceFlow());
const isLoading = $derived(getIsLoading());
</script>

{#if deviceFlow}
	<DeviceCodePanel
		host={deviceFlow.host}
		userCode={deviceFlow.userCode}
		verificationUri={deviceFlow.verificationUri}
		surface="elevated"
		copyLabel="icon"
	/>
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
