<script lang="ts">
import type { CheckDetails } from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import { Button } from "$lib/components/ui/button/index.js";
import type { RequestState } from "$lib/stores/_types";
import { getReviewFiles, jumpToDiffLine } from "$lib/stores/review.svelte";
import { renderMarkdown } from "$lib/utils/markdown";
import { interceptExternalLinks } from "$lib/utils/open-external";

interface Props {
  request: RequestState<CheckDetails>;
  onretry: () => void;
}

let { request, onretry }: Props = $props();

let copied = $state(false);

const UNAVAILABLE: Record<NonNullable<CheckDetails["logUnavailable"]>, string | null> = {
  not_actions: null,
  running: "The job is still running; its log appears once it finishes.",
  permission: "Your GitHub access can't read Actions logs for this repository.",
  expired: "GitHub no longer keeps this job's log.",
};

/** Paths the PR touches; an annotation elsewhere has no diff line to jump to. */
const prPaths = $derived(new Set(getReviewFiles().map((f) => f.path)));

async function copyLog(details: CheckDetails): Promise<void> {
  if (!details.log) return;
  await navigator.clipboard.writeText(details.log.lines.map((l) => l.text).join("\n"));
  copied = true;
  setTimeout(() => (copied = false), 1400);
}
</script>

<div class="details">
	{#if request.status === 'loading' || request.status === 'idle'}
		<div class="details-skeleton" aria-busy="true" aria-label="Loading check details">
			<span></span><span></span><span></span>
		</div>
	{:else if request.status === 'error'}
		<p class="details-error">
			Couldn't load this check: {request.error}
			<Button variant="ghost" size="xs" onclick={onretry}><ArrowClockwise />Retry</Button>
		</p>
	{:else}
		{@const details = request.data}
		{#if details.annotations.length > 0}
			<ul class="annotations">
				{#each details.annotations as annotation, i (i)}
					{@const inPr = prPaths.has(annotation.path)}
					<li class="annotation annotation--{annotation.level}">
						{#if inPr}
							<button
								type="button"
								class="annotation-path"
								title="Show in the diff"
								onclick={() => jumpToDiffLine(annotation.path, annotation.startLine)}
							>
								{annotation.path}:{annotation.startLine}
							</button>
						{:else}
							<span class="annotation-path">{annotation.path}:{annotation.startLine}</span>
						{/if}
						<p class="annotation-message">
							{#if annotation.title}<strong>{annotation.title}</strong> {/if}{annotation.message}
						</p>
					</li>
				{/each}
			</ul>
		{/if}

		{#if details.log}
			<div class="log">
				<div class="log-head">
					<span class="log-step">{details.log.stepName ?? 'Job log'}</span>
					{#if details.log.truncated}<span class="log-note">last {details.log.lines.length} lines</span>{/if}
					<Button variant="ghost" size="xs" onclick={() => void copyLog(details)}>
						{#if copied}<Check />Copied{:else}<Copy />Copy log{/if}
					</Button>
				</div>
				<pre class="log-body"><code
						>{#each details.log.lines as line, i (i)}<span class="log-line log-line--{line.kind}"
								>{line.text}
</span>{/each}</code
					></pre>
			</div>
		{:else if details.logUnavailable && UNAVAILABLE[details.logUnavailable]}
			<p class="details-note">{UNAVAILABLE[details.logUnavailable]}</p>
		{/if}

		{#if !details.log && details.summary}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="details-summary prose prose-sm prose-dense" onclick={interceptExternalLinks}>
				{@html renderMarkdown(details.summary)}
			</div>
		{/if}

		{#if details.annotations.length === 0 && !details.log && !details.summary && !(details.logUnavailable && UNAVAILABLE[details.logUnavailable])}
			<p class="details-note">This check reported no details. Open it on GitHub for more.</p>
		{/if}
	{/if}
</div>

<style>
	.details {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 4px 12px 12px 38px;
	}

	.details-skeleton {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.details-skeleton span {
		height: 10px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
	}

	.details-skeleton span:nth-child(2) {
		width: 70%;
	}

	.details-skeleton span:nth-child(3) {
		width: 45%;
	}

	.details-error,
	.details-note {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.annotations {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.annotation {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-warning) 7%, transparent);
	}

	.annotation--failure {
		background: color-mix(in srgb, var(--color-danger) 7%, transparent);
	}

	.annotation--notice {
		background: var(--color-bg-secondary);
	}

	.annotation-path {
		align-self: flex-start;
		padding: 0;
		border: none;
		background: none;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	button.annotation-path {
		cursor: pointer;
	}

	button.annotation-path:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}

	.annotation-message {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-primary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.log {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}

	.log-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 4px 4px 10px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		font-size: 0.75rem;
	}

	.log-step {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		color: var(--color-text-primary);
	}

	.log-note {
		color: var(--color-text-muted);
	}

	.log-body {
		max-height: 360px;
		margin: 0;
		padding: 8px 0;
		overflow: auto;
		background: var(--color-diff-bg, var(--color-bg-secondary));
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
	}

	.log-line {
		display: block;
		padding: 0 10px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.log-line--error {
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
		color: var(--color-danger);
	}

	.log-line--warning {
		color: var(--color-warning);
	}

	.log-line--group {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.details-summary {
		max-width: none;
		overflow-wrap: anywhere;
	}
</style>
