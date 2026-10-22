<script lang="ts">
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import Info from "phosphor-svelte/lib/Info";
import Spinner from "phosphor-svelte/lib/Spinner";
import Warning from "phosphor-svelte/lib/Warning";
import WarningOctagon from "phosphor-svelte/lib/WarningOctagon";
import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
import { getResolvedTheme } from "$lib/stores/theme.svelte";

let { ...restProps }: SonnerProps = $props();

// Sonner needs a concrete light/dark to stamp `data-theme` on the toaster,
// which drives every one of its styles the inline `--normal-*` overrides below
// don't reach. Feed it the *resolved* theme from Revv's own store rather than
// `"system"`: "system" would make sonner consult prefers-color-scheme directly
// and render dark toasts whenever the OS is dark, even with the app set to
// light. (This used to read `mode-watcher`'s store — a second theme library
// whose ModeWatcher component this app never mounts, so it tracked nothing but
// the OS.)
const theme = $derived(getResolvedTheme());
</script>

<Sonner
	{theme}
	position="top-right"
	closeButton
	class="toaster group"
	style="
		--normal-bg: var(--color-popover);
		--normal-text: var(--color-popover-foreground);
		--normal-border: var(--color-border);
		--normal-bg-hover: var(--color-bg-tertiary);
		--normal-border-hover: var(--color-border);
		--normal-description: var(--color-text-secondary);
		--gray2: var(--color-bg-tertiary);
		--gray4: var(--color-border);
		--gray5: var(--color-border);
		--gray12: var(--color-popover-foreground);
	"
	{...restProps}
>
	{#snippet loadingIcon()}
		<Spinner class="size-4 motion-essential-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CheckCircle class="size-4" weight="fill" />
	{/snippet}
	{#snippet errorIcon()}
		<WarningOctagon class="size-4" weight="fill" />
	{/snippet}
	{#snippet infoIcon()}
		<Info class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<Warning class="size-4" weight="fill" />
	{/snippet}
</Sonner>
