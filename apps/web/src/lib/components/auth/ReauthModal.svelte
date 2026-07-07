<script lang="ts">
import { GITHUB_CLIENT_ID_HINT, isLikelyGitHubClientId } from "@revv/shared";
import { GithubLogo, WarningCircle } from "phosphor-svelte";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import {
  cancelSignIn,
  getDeviceFlow,
  getError,
  getIsLoading,
  getReauthRequired,
  getSignInErrorCode,
  signIn,
} from "$lib/stores/auth.svelte";
import { setGithubConfigStrict } from "$lib/stores/settings.svelte";

const reauth = $derived(getReauthRequired());
const deviceFlow = $derived(getDeviceFlow());
const error = $derived(getError());
const signInErrorCode = $derived(getSignInErrorCode());
const isLoading = $derived(getIsLoading());

let copied = $state(false);
let clientId = $state("");
let clientIdError = $state<string | null>(null);
let isSavingClientId = $state(false);

const needsClientId = $derived(
  Boolean(
    reauth?.host &&
      reauth.host !== "github.com" &&
      (signInErrorCode === "missing_github_client_id" ||
        signInErrorCode === "invalid_github_client_id" ||
        clientIdError),
  ),
);

async function copyCode(): Promise<void> {
  if (!deviceFlow) return;
  await navigator.clipboard.writeText(deviceFlow.userCode);
  copied = true;
  setTimeout(() => (copied = false), 2000);
}

function startReauth(): void {
  // Re-auth against the same GitHub host the expired account belongs to so
  // GHE accounts land on the right instance.
  void signIn(reauth?.host ?? undefined);
}

async function saveClientIdAndRetry(): Promise<void> {
  const host = reauth?.host;
  const trimmed = clientId.trim();
  if (!host || !trimmed || isSavingClientId) return;

  clientIdError = null;
  if (!isLikelyGitHubClientId(trimmed)) {
    clientIdError = GITHUB_CLIENT_ID_HINT;
    return;
  }

  isSavingClientId = true;
  try {
    await setGithubConfigStrict(host, trimmed);
    const started = await signIn(host);
    if (!started) {
      clientIdError = getError() ?? "Failed to start sign-in. Check the client ID and try again.";
    }
  } catch (e) {
    clientIdError = e instanceof Error ? e.message : String(e);
  } finally {
    isSavingClientId = false;
  }
}
</script>

{#if reauth}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6 supports-backdrop-filter:backdrop-blur-sm"
		in:gsapFade={{ duration: tokens.smooth }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="reauth-title"
	>
		<div
			class="flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-border bg-bg-elevated p-8 text-center shadow-xl"
			in:gsapFadeY={{ y: 12, duration: tokens.smooth }}
		>
			<div class="flex size-12 items-center justify-center rounded-full bg-warning/10 text-warning">
				<WarningCircle size={28} weight="duotone" />
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
				<div class="flex flex-col items-center gap-4">
					<p class="text-sm text-text-secondary">Enter this code on GitHub:</p>
					<div
						class="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-6 py-3"
					>
						<span class="font-mono text-2xl font-bold tracking-widest text-text-primary">
							{deviceFlow.userCode}
						</span>
						<button
							onclick={copyCode}
							class="ml-1 cursor-pointer rounded p-1 text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
							aria-label="Copy code"
						>
							{copied ? "Copied" : "Copy"}
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
				{#if error && !clientIdError}
					<p class="text-sm text-danger">{error}</p>
				{/if}
				{#if needsClientId}
					<form
						class="flex w-full flex-col gap-3 text-left"
						onsubmit={(e) => {
							e.preventDefault();
							void saveClientIdAndRetry();
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
							disabled={isSavingClientId || clientId.trim().length === 0}
						>
							<GithubLogo size={18} weight="fill" />
							Save and sign in
						</button>
					</form>
				{:else}
					<button
						class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
						onclick={startReauth}
						disabled={isLoading}
					>
						<GithubLogo size={18} weight="fill" />
						Sign in again
					</button>
				{/if}
			{/if}
		</div>
	</div>
{/if}
