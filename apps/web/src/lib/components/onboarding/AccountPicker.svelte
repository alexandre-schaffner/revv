<script lang="ts">
import ArrowRight from "phosphor-svelte/lib/ArrowRight";
import Monitor from "phosphor-svelte/lib/Desktop";
import Moon from "phosphor-svelte/lib/Moon";
import Loader2 from "phosphor-svelte/lib/Spinner";
import Sun from "phosphor-svelte/lib/Sun";
import User from "phosphor-svelte/lib/User";
import { fade } from "svelte/transition";
import { getIsSwitching, getLocalAccounts, switchAccount } from "$lib/stores/auth.svelte";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";

interface Props {
  /** Called when user chooses "Sign in with a different account" */
  onNewAccount: () => void;
}

let { onNewAccount }: Props = $props();

const localAccounts = $derived(getLocalAccounts());
const isSwitching = $derived(getIsSwitching());

let switchingId = $state<string | null>(null);

function hostLabel(host: string): string {
  if (host === "github.com") return "GitHub";
  return host;
}

async function handlePick(userId: string, host: string): Promise<void> {
  if (isSwitching) return;
  switchingId = `${userId}:${host}`;
  try {
    await switchAccount(userId, host);
  } finally {
    // Clear local state in case it fails. On success, OnboardingGate
    // swaps to the app shell automatically.
    switchingId = null;
  }
}

const theme = $derived(getThemePreference());
const cycle: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const labels: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};
function cycleTheme() {
  setThemePreference(cycle[theme]);
}
</script>

<div class="picker" in:fade={{ duration: 320 }}>
    <button class="theme-toggle" onclick={cycleTheme} aria-label={labels[theme]} title={labels[theme]}>
        {#if theme === 'light'}
            <Sun size={14} weight="fill" />
        {:else if theme === 'dark'}
            <Moon size={14} weight="fill" />
        {:else}
            <Monitor size={14} weight="fill" />
        {/if}
    </button>
    <div class="picker-header">
        <h1 class="picker-title">Welcome back.</h1>
        <p class="picker-subtitle">Pick an account to continue.</p>
    </div>

    <div class="picker-accounts">
        {#each localAccounts as la (la.id)}
            {#each la.accounts as acct (`${la.id}:${acct.host}`)}
                {@const key = `${la.id}:${acct.host}`}
                {@const switching = switchingId === key}
                <button
                    class="picker-card"
                    onclick={() => handlePick(la.id, acct.host)}
                    disabled={isSwitching}
                >
                    <span class="picker-card-avatar">
                        {#if acct.avatarUrl ?? la.image}
                            <img
                                src={acct.avatarUrl ?? la.image}
                                alt=""
                                class="picker-card-img"
                                referrerpolicy="no-referrer"
                            />
                        {:else}
                            <User size={18} weight="regular" class="picker-card-icon" />
                        {/if}
                    </span>
                    <span class="picker-card-body">
                        <span class="picker-card-login">{acct.githubLogin ?? la.name}</span>
                        <span class="picker-card-host">{la.email} · {hostLabel(acct.host)}</span>
                    </span>
                    <span class="picker-card-action">
                        {#if switching}
                            <Loader2 size={14} weight="regular" class="picker-spinner motion-essential-spin" />
                        {:else}
                            <ArrowRight size={14} class="picker-arrow" />
                        {/if}
                    </span>
                </button>
            {/each}
        {/each}
    </div>

    <div class="picker-footer">
        <button class="picker-new" onclick={onNewAccount} disabled={isSwitching}>
            Sign in with a different account
        </button>
    </div>
</div>

<style>
    .picker {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 48px 24px;
        gap: 32px;
    }

    .theme-toggle {
        position: absolute;
        top: 16px;
        right: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: 1px solid var(--color-border);
        border-radius: 6px;
        background: var(--color-bg-secondary, var(--color-bg-elevated));
        color: var(--color-text-muted);
        cursor: pointer;
        transition: background-color var(--duration-snap), color var(--duration-snap);
    }

    .theme-toggle:hover {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
    }

    .picker-header {
        text-align: center;
    }

    .picker-title {
        font-size: 28px;
        font-weight: 700;
        color: var(--color-text-primary);
        margin: 0;
    }

    .picker-subtitle {
        font-size: 14px;
        color: var(--color-text-muted);
        margin: 8px 0 0;
    }

    .picker-accounts {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        max-width: 340px;
    }

    .picker-card {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 12px 16px;
        border: 1px solid var(--color-border);
        border-radius: 10px;
        background: var(--color-bg-secondary, var(--color-bg-elevated));
        color: var(--color-text-primary);
        cursor: pointer;
        text-align: left;
        transition:
            background-color var(--duration-snap),
            border-color var(--duration-snap),
            transform var(--duration-snap);
    }

    .picker-card:hover:not(:disabled) {
        background: var(--color-bg-tertiary);
        border-color: var(--color-border-subtle, var(--color-border));
        transform: translateY(-1px);
    }

    .picker-card:active:not(:disabled) {
        transform: translateY(0);
    }

    .picker-card:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .picker-card-avatar {
        flex-shrink: 0;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .picker-card-img {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        object-fit: cover;
    }

    :global(.picker-card-icon) {
        color: var(--color-text-muted);
    }

    .picker-card-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
    }

    .picker-card-login {
        font-size: 14px;
        font-weight: 600;
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .picker-card-host {
        font-size: 12px;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .picker-card-action {
        flex-shrink: 0;
        display: flex;
        align-items: center;
    }

    :global(.picker-arrow) {
        color: var(--color-text-muted);
        transition: color var(--duration-snap);
    }

    .picker-card:hover:not(:disabled) :global(.picker-arrow) {
        color: var(--color-text-primary);
    }

    :global(.picker-spinner) {
        color: var(--color-text-muted);
    }

    .picker-footer {
        margin-top: 8px;
    }

    .picker-new {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--color-accent);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color var(--duration-snap);
    }

    .picker-new:hover:not(:disabled) {
        background: color-mix(in srgb, var(--color-accent) 8%, transparent);
    }

    .picker-new:disabled {
        opacity: 0.5;
        cursor: default;
    }

    @media (prefers-reduced-motion: reduce) {
        .picker-card:hover:not(:disabled) {
            transform: none;
        }
    }
</style>
