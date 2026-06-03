<script lang="ts">
import { mode } from "mode-watcher";
import CircleCheckIcon from "phosphor-svelte/lib/CheckCircle";
import InfoIcon from "phosphor-svelte/lib/Info";
import Loader2Icon from "phosphor-svelte/lib/Spinner";
import TriangleAlertIcon from "phosphor-svelte/lib/Warning";
import OctagonXIcon from "phosphor-svelte/lib/WarningOctagon";
import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";

let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme={(mode.current ?? 'system') as 'light' | 'dark' | 'system'}
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
		<Loader2Icon class="size-4 motion-essential-spin" />
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
