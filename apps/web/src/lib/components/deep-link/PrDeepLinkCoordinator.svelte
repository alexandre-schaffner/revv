<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import FolderPlus from "phosphor-svelte/lib/FolderPlus";
import GithubLogo from "phosphor-svelte/lib/GithubLogo";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import Spinner from "phosphor-svelte/lib/Spinner";
import User from "phosphor-svelte/lib/User";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { onDestroy, tick } from "svelte";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { Input } from "$lib/components/ui/input";
import { gsapFadeY, tokens } from "$lib/motion";
import {
  getDeviceFlow,
  getError,
  getIsAuthenticated,
  getIsOnboarded,
} from "$lib/stores/auth.svelte";
import {
  addPrDeepLinkRepository,
  chooseAnotherPrDeepLinkAccount,
  choosePrDeepLinkAccount,
  connectPrDeepLinkAccount,
  deepLinkNeedsClientId,
  dismissPrDeepLink,
  getDeepLinkClientId,
  getPrDeepLinkLoadingVisible,
  getPrDeepLinkState,
  matchingAccountsFor,
  resumePendingPrDeepLink,
  retryPrDeepLink,
  settlePrDeepLinkAuthorization,
} from "$lib/stores/pr-deep-link.svelte";

const workflow = $derived(getPrDeepLinkState());
const loadingVisible = $derived(getPrDeepLinkLoadingVisible());
const deviceFlow = $derived(getDeviceFlow());
const authError = $derived(getError());
const waitingForOnboarding = $derived(
  workflow.kind === "resolving" && getIsAuthenticated() && !getIsOnboarded(),
);
const open = $derived(
  workflow.kind !== "idle" &&
    !waitingForOnboarding &&
    (workflow.kind !== "resolving" || loadingVisible),
);
const matchingAccounts = $derived(
  workflow.kind === "idle" ? [] : matchingAccountsFor(workflow.locator.githubHost),
);

let clientId = $state("");
let clientIdError = $state<string | null>(null);
let clientIdLocator = "";
let copiedCode = $state(false);
let accountButtons: HTMLButtonElement[] = [];
let copiedCodeTimer: ReturnType<typeof setTimeout> | null = null;

onDestroy(() => {
  if (copiedCodeTimer) clearTimeout(copiedCodeTimer);
});

$effect(() => {
  const current = workflow;
  if (current.kind !== "connect-account") return;
  const key = current.locator.githubHost;
  if (clientIdLocator !== key) {
    clientIdLocator = key;
    clientId = getDeepLinkClientId(current.locator);
    clientIdError = null;
  }
});

$effect(() => {
  const shouldResume = !getIsAuthenticated() || getIsOnboarded();
  if (shouldResume && workflow.kind === "resolving") resumePendingPrDeepLink();
});

$effect(() => {
  if (
    workflow.kind === "connect-account" &&
    workflow.phase === "device-code" &&
    deviceFlow === null
  ) {
    void settlePrDeepLinkAuthorization(authError);
  }
});

$effect(() => {
  if (!open || workflow.kind === "resolving") return;
  void tick().then(() => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-pr-deep-link-autofocus]")?.focus();
    });
  });
});

function locatorLabel(): string {
  if (workflow.kind === "idle") return "";
  return `${workflow.locator.repositoryFullName} #${workflow.locator.number}`;
}

function handleOpenChange(nextOpen: boolean): void {
  if (!nextOpen && workflow.kind !== "adding-repository") dismissPrDeepLink();
}

function handleAccountKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const next = (index + direction + accountButtons.length) % accountButtons.length;
  accountButtons[next]?.focus();
}

async function handleConnect(): Promise<void> {
  clientIdError = await connectPrDeepLinkAccount(clientId);
}

async function copyDeviceCode(): Promise<void> {
  if (!deviceFlow) return;
  try {
    await navigator.clipboard.writeText(deviceFlow.userCode);
    copiedCode = true;
    if (copiedCodeTimer) clearTimeout(copiedCodeTimer);
    copiedCodeTimer = setTimeout(() => {
      copiedCode = false;
      copiedCodeTimer = null;
    }, 1400);
  } catch {
    copiedCode = false;
  }
}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content
    class="pr-deep-link-dialog"
    showCloseButton={workflow.kind !== "adding-repository"}
  >
    {#if workflow.kind !== "idle"}
      {#key workflow.kind}
        <div class="dialog-body" in:gsapFadeY={{ y: 4, duration: tokens.quick }}>
          <Dialog.Header class="dialog-header">
            <span
              class:error-icon={workflow.kind === "error"}
              class="leading-icon"
              aria-hidden="true"
            >
              {#if workflow.kind === "error"}
                <WarningCircle size={20} weight="fill" />
              {:else if workflow.kind === "confirm-repository" || workflow.kind === "adding-repository"}
                <FolderPlus size={19} />
              {:else if workflow.kind === "connect-account"}
                <GithubLogo size={19} />
              {:else}
                <LinkSimple size={19} />
              {/if}
            </span>

            <span class="heading-copy">
              <Dialog.Title class="dialog-title">
                {#if workflow.kind === "resolving"}
                  Open PR
                {:else if workflow.kind === "choose-account"}
                  Choose an account for {workflow.locator.githubHost}
                {:else if workflow.kind === "connect-account"}
                  Connect an account for {workflow.locator.githubHost}
                {:else if workflow.kind === "confirm-repository"}
                  Add {workflow.locator.repositoryFullName} to Revv?
                {:else if workflow.kind === "adding-repository"}
                  Adding repository
                {:else if workflow.reason === "forbidden"}
                  You can’t access this PR
                {:else if workflow.reason === "not-found"}
                  PR not found
                {:else}
                  Revv couldn’t open this PR
                {/if}
              </Dialog.Title>

              {#if workflow.kind === "choose-account"}
                <Dialog.Description>This link points to {locatorLabel()}.</Dialog.Description>
              {:else if workflow.kind === "resolving"}
                <Dialog.Description class="sr-only">Opening {locatorLabel()}.</Dialog.Description>
              {:else if workflow.kind === "connect-account"}
                <Dialog.Description>
                  Sign in to open {locatorLabel()}. The link will resume after authorization.
                </Dialog.Description>
              {:else if workflow.kind === "confirm-repository"}
                <Dialog.Description>
                  PR #{workflow.locator.number} is in a repository this account does not track. Revv will add
                  the repository and create a managed clone.
                </Dialog.Description>
              {:else if workflow.kind === "error"}
                <Dialog.Description role="alert">{workflow.message}</Dialog.Description>
              {:else if workflow.kind === "adding-repository"}
                <Dialog.Description class="sr-only">
                  Adding {workflow.locator.repositoryFullName} to Revv.
                </Dialog.Description>
              {/if}
            </span>
          </Dialog.Header>

          {#if workflow.kind === "resolving"}
            <div class="status-row" aria-live="polite">
              <Dotmatrix variant="square-13" size="small" />
              <span>Opening {locatorLabel()}…</span>
            </div>
          {:else if workflow.kind === "choose-account"}
            <div class="account-list" aria-label="Accounts">
              {#each workflow.accounts as account, index (`${account.userId}:${account.host}`)}
                <button
                  bind:this={accountButtons[index]}
                  class="account-row"
                  data-pr-deep-link-autofocus={index === 0 ? "" : undefined}
                  onclick={() => void choosePrDeepLinkAccount(account)}
                  onkeydown={(event) => handleAccountKeydown(event, index)}
                  aria-label={`${account.login}, ${account.email}, ${account.host}`}
                >
                  <span class="account-avatar">
                    {#if account.avatarUrl}
                      <img src={account.avatarUrl} alt="" referrerpolicy="no-referrer" />
                    {:else}
                      <User size={15} />
                    {/if}
                  </span>
                  <span class="account-copy">
                    <span class="account-login">{account.login}</span>
                    <span class="account-meta">{account.email} · {account.host}</span>
                  </span>
                </button>
              {/each}
            </div>
          {:else if workflow.kind === "connect-account"}
            <div class="host-confirmation">
              <span>Authorize with GitHub host</span>
              <code>{workflow.locator.githubHost}</code>
            </div>
            {#if workflow.phase === "settling"}
              <div class="status-row" aria-live="polite">
                <Dotmatrix variant="square-13" size="small" />
                <span>Finishing account setup</span>
              </div>
            {:else if workflow.phase === "device-code" && deviceFlow}
              <div class="device-code-panel">
                <code>{deviceFlow.userCode}</code>
                <Button variant="outline" size="sm" onclick={copyDeviceCode}>
                  {#if copiedCode}<Check data-icon="inline-start" />{:else}<Copy data-icon="inline-start" />{/if}
                  {copiedCode ? "Copied" : "Copy code"}
                </Button>
                <div class="status-row" aria-live="polite">
                  <Dotmatrix variant="square-13" size="small" />
                  <span>Awaiting authorization</span>
                </div>
              </div>
            {:else}
              {#if deepLinkNeedsClientId(workflow.locator)}
                <label class="client-id-field">
                  <span>GitHub App client ID</span>
                  <Input
                    data-pr-deep-link-autofocus
                    type="text"
                    bind:value={clientId}
                    aria-invalid={clientIdError ? "true" : undefined}
                    placeholder="Iv23xxxxxxxxxxxxxxxx"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                  />
                </label>
              {/if}
              {#if clientIdError || authError}
                <p class="inline-error" role="alert">{clientIdError ?? authError}</p>
              {/if}
            {/if}
          {:else if workflow.kind === "confirm-repository" && workflow.clonePath}
            <p class="clone-path" title={workflow.clonePath}>{workflow.clonePath}</p>
          {:else if workflow.kind === "adding-repository"}
            <div class="status-row" aria-live="polite">
              <Spinner size={15} class="motion-essential-spin" />
              <span>Adding repository…</span>
            </div>
          {/if}

          {#if workflow.kind !== "resolving" && workflow.kind !== "adding-repository"}
            <Dialog.Footer class="dialog-footer">
              {#if workflow.kind === "choose-account"}
                <Button variant="outline" onclick={dismissPrDeepLink}>Cancel</Button>
              {:else if workflow.kind === "connect-account"}
                <Button variant="outline" onclick={dismissPrDeepLink}>Cancel</Button>
                {#if workflow.phase === "entry"}
                  <Button
                    data-pr-deep-link-autofocus={!deepLinkNeedsClientId(workflow.locator) ? "" : undefined}
                    onclick={() => void handleConnect()}
                  >Connect account</Button>
                {/if}
              {:else if workflow.kind === "confirm-repository"}
                <Button variant="outline" onclick={dismissPrDeepLink}>Cancel</Button>
                <Button data-pr-deep-link-autofocus onclick={() => void addPrDeepLinkRepository()}>
                  Add repository
                </Button>
              {:else if workflow.kind === "error"}
                {#if workflow.reason === "forbidden" && matchingAccounts.length > 0}
                  <Button variant="outline" onclick={chooseAnotherPrDeepLinkAccount}>Choose account</Button>
                {/if}
                <Button
                  variant={workflow.reason === "network" ? "outline" : "default"}
                  data-pr-deep-link-autofocus={workflow.reason !== "network" ? "" : undefined}
                  onclick={dismissPrDeepLink}
                >Dismiss</Button>
                {#if workflow.reason === "network"}
                  <Button data-pr-deep-link-autofocus onclick={retryPrDeepLink}>Try again</Button>
                {/if}
              {/if}
            </Dialog.Footer>
          {/if}
        </div>
      {/key}
    {/if}
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.pr-deep-link-dialog) {
    width: 420px;
    max-width: calc(100vw - 32px);
    padding: 20px;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  :global(.dialog-header) {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    gap: 10px;
    padding-right: 24px;
  }

  .leading-icon {
    align-items: center;
    color: var(--color-text-secondary);
    display: inline-flex;
    height: 28px;
    justify-content: center;
    width: 28px;
  }

  .leading-icon.error-icon {
    color: var(--color-danger);
  }

  .heading-copy,
  .account-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 5px;
  }

  :global(.dialog-title) {
    font-family: var(--font-sans, Inter, sans-serif);
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
  }

  .status-row {
    align-items: center;
    color: var(--color-text-secondary);
    display: flex;
    font-size: 13px;
    gap: 10px;
    min-height: 32px;
  }

  .account-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .account-row {
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-text-primary);
    cursor: pointer;
    display: flex;
    gap: 10px;
    min-width: 0;
    padding: 8px;
    text-align: left;
    width: 100%;
  }

  .account-row:hover {
    background: var(--color-bg-tertiary);
  }

  .account-row:focus-visible {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px var(--color-input-focus-ring);
    outline: none;
  }

  .account-avatar,
  .account-avatar img {
    align-items: center;
    border-radius: 999px;
    display: flex;
    flex-shrink: 0;
    height: 24px;
    justify-content: center;
    object-fit: cover;
    width: 24px;
  }

  .account-avatar {
    background: var(--color-bg-tertiary);
    color: var(--color-text-muted);
  }

  .account-login {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-meta {
    color: var(--color-text-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .client-id-field {
    color: var(--color-text-secondary);
    display: flex;
    flex-direction: column;
    font-size: 12px;
    font-weight: 500;
    gap: 6px;
  }

  .host-confirmation {
    align-items: center;
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border-subtle);
    border-radius: 8px;
    color: var(--color-text-secondary);
    display: flex;
    font-size: 12px;
    justify-content: space-between;
    padding: 8px 10px;
  }

  .host-confirmation code {
    color: var(--color-text-primary);
    font-family: var(--font-mono, monospace);
    font-weight: 600;
  }

  .device-code-panel {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .device-code-panel code {
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text-primary);
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.12em;
    padding: 5px 10px;
  }

  .device-code-panel .status-row {
    flex-basis: 100%;
  }

  .inline-error {
    color: var(--color-danger);
    font-size: 12px;
    margin: 0;
  }

  .clone-path {
    color: var(--color-text-muted);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    margin: 0 0 0 38px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.dialog-footer) {
    margin-top: 2px;
  }
</style>
