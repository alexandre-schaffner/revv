<script lang="ts">
import CircleCheckIcon from "phosphor-svelte/lib/CheckCircle";
import InfoIcon from "phosphor-svelte/lib/Info";
import Loader2Icon from "phosphor-svelte/lib/Spinner";
import OctagonXIcon from "phosphor-svelte/lib/X";
import TriangleAlertIcon from "phosphor-svelte/lib/Warning";
import { mode } from "mode-watcher";
import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";

let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme={(mode.current ?? 'system') as 'light' | 'dark' | 'system'}
	position="top-right"
	class="toaster group"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border); --normal-description: var(--color-text-secondary);"
	{...restProps}
>
	{#snippet loadingIcon()}
		<Loader2Icon class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CircleCheckIcon class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4" />
	{/snippet}
</Sonner>
