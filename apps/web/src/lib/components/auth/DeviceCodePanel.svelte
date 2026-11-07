<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import { cancelSignIn } from "$lib/stores/auth.svelte";
import { copyFeedback } from "$lib/utils/copy-feedback.svelte";

interface Props {
  /** The host the sign-in is on: Cancel stops that one. */
  host: string;
  userCode: string;
  verificationUri: string;
  /** Background of the code box, chosen to contrast with the surface it sits on. */
  surface: "elevated" | "tertiary";
  copyLabel: "text" | "icon";
}

let { host, userCode, verificationUri, surface, copyLabel }: Props = $props();

const clipboard = copyFeedback(2000);
</script>

<div class="flex flex-col items-center gap-4 text-center">
	<p class="text-sm text-text-secondary">Enter this code on GitHub:</p>
	<div
		class="flex items-center gap-2 rounded-lg border border-border px-6 py-3 {surface === 'elevated'
			? 'bg-bg-elevated'
			: 'bg-bg-tertiary'}"
	>
		<span class="font-mono text-2xl font-bold tracking-widest text-text-primary">{userCode}</span>
		<button
			onclick={() => void clipboard.copy(userCode)}
			class="ml-1 cursor-pointer rounded p-1 text-text-muted transition-colors hover:text-text-primary {surface ===
			'elevated'
				? 'hover:bg-bg-tertiary'
				: 'hover:bg-bg-elevated'}"
			aria-label="Copy code"
		>
			{#if copyLabel === 'text'}
				{clipboard.copied ? 'Copied' : 'Copy'}
			{:else if clipboard.copied}
				<Check class="h-4 w-4 text-success" />
			{:else}
				<Copy class="h-4 w-4" />
			{/if}
		</button>
	</div>
	<a
		href={verificationUri}
		target="_blank"
		rel="noopener noreferrer"
		class="text-xs text-accent hover:underline"
	>
		{verificationUri}
	</a>
	<p class="text-xs text-text-muted">Waiting for authorization…</p>
	<button
		class="cursor-pointer text-xs text-text-muted underline hover:text-text-secondary"
		onclick={() => cancelSignIn(host)}
	>
		Cancel
	</button>
</div>
