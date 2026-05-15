<script lang="ts">
	import type { CloneStatus } from '@revv/shared';
	import { Clock, Loader2, Check, AlertCircle } from '@lucide/svelte';
	import { fade } from 'svelte/transition';

	let {
		status,
		error = null,
		onRetry,
		size = 12,
		showLabel = false,
	}: {
		status: CloneStatus;
		error?: string | null;
		onRetry?: () => void;
		size?: number;
		showLabel?: boolean;
	} = $props();

	// Transient success: when we observe a transition from any non-ready state
	// into 'ready', flash a green check for 2s then hide. Repos already in
	// 'ready' at first render stay silent — prevStatus starts undefined and the
	// first effect run only records the baseline.
	let showSuccess = $state(false);
	let prevStatus: CloneStatus | undefined;

	$effect(() => {
		const curr = status;
		if (prevStatus !== undefined && prevStatus !== 'ready' && curr === 'ready') {
			showSuccess = true;
			const t = setTimeout(() => {
				showSuccess = false;
			}, 2000);
			prevStatus = curr;
			return () => clearTimeout(t);
		}
		prevStatus = curr;
	});

	let tooltip = $derived.by(() => {
		switch (status) {
			case 'pending':
				return 'Waiting to clone';
			case 'cloning':
				return 'Cloning repository…';
			case 'ready':
				return showSuccess ? 'Clone complete' : '';
			case 'error':
				return error && error.length > 0 ? error : 'Clone failed — click to retry';
		}
	});

	let label = $derived.by(() => {
		switch (status) {
			case 'pending':
				return 'Pending';
			case 'cloning':
				return 'Cloning…';
			case 'ready':
				return showSuccess ? 'Ready' : '';
			case 'error':
				return 'Clone failed';
		}
	});

	function handleRetry(e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		onRetry?.();
	}

	function handleRetryKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.stopPropagation();
			e.preventDefault();
			onRetry?.();
		}
	}
</script>

{#if status === 'error' && onRetry}
	<!--
		Rendered as a role="button" span instead of a real <button> because
		callers (RepoGroup, AddRepoForm) wrap their rows in a <button>, and
		HTML disallows nested interactive elements. stopPropagation prevents
		the row toggle/add from firing.
	-->
	<span
		role="button"
		tabindex="0"
		class="inline-flex cursor-pointer items-center gap-1 text-danger transition-colors hover:text-danger/80"
		title={tooltip}
		aria-label={tooltip}
		onclick={handleRetry}
		onkeydown={handleRetryKey}
	>
		<AlertCircle {size} />
		{#if showLabel}
			<span class="text-[11px] font-medium">{label}</span>
		{/if}
	</span>
{:else if status === 'error'}
	<span class="inline-flex items-center gap-1 text-danger" title={tooltip} aria-label={tooltip}>
		<AlertCircle {size} />
		{#if showLabel}
			<span class="text-[11px] font-medium">{label}</span>
		{/if}
	</span>
{:else if status === 'cloning'}
	<span class="inline-flex items-center gap-1 text-accent" title={tooltip} aria-label={tooltip}>
		<Loader2 {size} class="motion-essential-spin" />
		{#if showLabel}
			<span class="text-[11px] font-medium">{label}</span>
		{/if}
	</span>
{:else if status === 'pending'}
	<span
		class="inline-flex items-center gap-1 text-text-muted"
		title={tooltip}
		aria-label={tooltip}
	>
		<Clock {size} />
		{#if showLabel}
			<span class="text-[11px] font-medium">{label}</span>
		{/if}
	</span>
{:else if status === 'ready' && showSuccess}
	<span
		class="inline-flex items-center gap-1 text-success"
		title={tooltip}
		aria-label={tooltip}
		transition:fade
	>
		<Check {size} />
		{#if showLabel}
			<span class="text-[11px] font-medium">{label}</span>
		{/if}
	</span>
{/if}
