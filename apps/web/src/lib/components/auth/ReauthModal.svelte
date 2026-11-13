<script lang="ts">
import { GITHUB_CLIENT_ID_HINT, isLikelyGitHubClientId, isPublicGitHub } from "@revv/shared";
import GithubLogo from "phosphor-svelte/lib/GithubLogo";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import X from "phosphor-svelte/lib/X";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import {
  closeReauth,
  getDeviceFlow,
  getErrorFor,
  getIsLoading,
  getReauthPrompt,
  getSignInErrorCode,
  signIn,
} from "$lib/stores/auth.svelte";
import DeviceCodePanel from "./DeviceCodePanel.svelte";

const prompt = $derived(getReauthPrompt());
const reauth = $derived(prompt?.account ?? null);
const dismissible = $derived(prompt !== null && !prompt.blocking);
const deviceFlow = $derived(reauth ? getDeviceFlow(reauth.host) : null);
const error = $derived(reauth ? getErrorFor(reauth.host) : null);
const signInErrorCode = $derived(reauth ? getSignInErrorCode(reauth.host) : null);
const isLoading = $derived(getIsLoading());

let clientId = $state("");
let clientIdError = $state<string | null>(null);
let isStartingWithClientId = $state(false);

const needsClientId = $derived(
  Boolean(
    reauth?.host && !isPublicGitHub(reauth.host) && (signInErrorCode !== null || clientIdError),
  ),
);

function startReauth(): void {
  if (reauth) void signIn(reauth.host);
}

function dismiss(): void {
  clientIdError = null;
  closeReauth();
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (dismissible && event.key === "Escape") dismiss();
}

// The typed id is this sign-in's input only: the poll stores it on the
// account, and the machine-wide settings row (and so the active host) stays.
async function retryWithClientId(): Promise<void> {
  const host = reauth?.host;
  const trimmed = clientId.trim();
  if (!host || !trimmed || isStartingWithClientId) return;

  clientIdError = null;
  if (!isLikelyGitHubClientId(trimmed)) {
    clientIdError = GITHUB_CLIENT_ID_HINT;
    return;
  }

  isStartingWithClientId = true;
  try {
    const started = await signIn(host, trimmed);
    if (!started) {
      clientIdError =
        getErrorFor(host) ?? "Failed to start sign-in. Check the client ID and try again.";
    }
  } finally {
    isStartingWithClientId = false;
  }
}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if reauth}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6 supports-backdrop-filter:backdrop-blur-sm"
		data-glass
		in:gsapFade={{ duration: tokens.smooth }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="reauth-title"
	>
		<div
			class="relative flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-border bg-bg-elevated p-8 text-center shadow-xl"
			in:gsapFadeY={{ y: 12, duration: tokens.smooth }}
		>
			{#if dismissible}
				<button
					class="absolute top-3 right-3 flex size-7 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
					onclick={dismiss}
					aria-label="Not now"
					title="Not now"
				>
					<X size={14} />
				</button>
			{/if}
			<div class="flex size-12 items-center justify-center rounded-full bg-warning/10 text-warning">
				<WarningCircle size={28} weight="fill" />
			</div>

			<div class="flex flex-col gap-1.5">
				<h2 id="reauth-title" class="text-lg font-semibold text-text-primary">
					GitHub session expired
				</h2>
				<p class="text-sm text-text-secondary">
					{#if reauth.githubLogin}
						Your token for <span class="font-medium text-text-primary">{reauth.githubLogin}</span>
						{#if reauth.host}on {reauth.host}{/if} is no longer valid.
					{:else}
						Your GitHub token is no longer valid.
					{/if}
					Sign in again to keep syncing pull requests.
				</p>
			</div>

			{#if deviceFlow}
				<DeviceCodePanel
					host={deviceFlow.host}
					userCode={deviceFlow.userCode}
					verificationUri={deviceFlow.verificationUri}
					surface="tertiary"
					copyLabel="text"
				/>
			{:else}
				{#if error && !clientIdError}
					<p class="text-sm text-danger">{error}</p>
				{/if}
				{#if needsClientId}
					<form
						class="flex w-full flex-col gap-3 text-left"
						onsubmit={(e) => {
							e.preventDefault();
							void retryWithClientId();
						}}
					>
						<label class="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
							GitHub App client ID for {reauth.host}
							<input
								class="h-10 rounded-lg border border-border bg-bg-tertiary px-3 text-sm text-text-primary outline-none focus:border-accent"
								type="text"
								autocapitalize="off"
								autocorrect="off"
								spellcheck="false"
								placeholder="Iv23xxxxxxxxxxxxxxxx"
								bind:value={clientId}
							/>
						</label>
						{#if clientIdError}
							<p class="text-sm text-danger">{clientIdError}</p>
						{/if}
						<button
							class="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-bg-tertiary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
							type="submit"
							disabled={isStartingWithClientId || clientId.trim().length === 0}
						>
							<GithubLogo size={18} />
							Sign in
						</button>
					</form>
				{:else}
					<button
						class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
						onclick={startReauth}
						disabled={isLoading}
					>
						<GithubLogo size={18} />
						Sign in again
					</button>
				{/if}
			{/if}
		</div>
	</div>
{/if}
