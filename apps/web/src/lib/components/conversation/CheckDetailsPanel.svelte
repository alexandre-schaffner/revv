<script lang="ts">
import type { CheckAnnotation, CheckDetails } from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import Info from "phosphor-svelte/lib/Info";
import Warning from "phosphor-svelte/lib/Warning";
import XCircle from "phosphor-svelte/lib/XCircle";
import { Button } from "$lib/components/ui/button/index.js";
import type { RequestState } from "$lib/stores/_types";
import { getReviewFiles, jumpToDiffLine } from "$lib/stores/review.svelte";
import MarkdownBody from "./MarkdownBody.svelte";

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

const LEVEL_LABEL: Record<CheckAnnotation["level"], string> = {
  failure: "Failure",
  warning: "Warning",
  notice: "Notice",
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
			<!-- Plain rows, not filled boxes: the icon carries the severity, and the
			     message leads because it's what the reader came for. -->
			<ul class="annotations">
				{#each details.annotations as annotation, i (i)}
					{@const inPr = prPaths.has(annotation.path)}
					<li class="annotation annotation--{annotation.level}">
						<span class="annotation-icon" role="img" aria-label={LEVEL_LABEL[annotation.level]}>
							{#if annotation.level === 'failure'}
								<XCircle size={14} />
							{:else if annotation.level === 'warning'}
								<Warning size={14} />
							{:else}
								<Info size={14} />
							{/if}
						</span>
						<div class="annotation-body">
							<p class="annotation-message">{annotation.message}</p>
							<p class="annotation-meta">
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
								{#if annotation.title}<span class="annotation-title">{annotation.title}</span>{/if}
							</p>
						</div>
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
			<MarkdownBody source={details.summary} />
		{/if}

		{#if details.annotations.length === 0 && !details.log && !details.summary && !(details.logUnavailable && UNAVAILABLE[details.logUnavailable])}
			<p class="details-note">This check reported no details.</p>
		{/if}
	{/if}
</div>

<style>
	.details {
		display: flex;
		flex-direction: column;
		gap: 10px;
		/* 34px = CiChecks' row inset + caret slot + gap: the body starts on the
		   status glyph's column. */
		padding: 2px 16px 12px 34px;
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
		gap: 10px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.annotation {
		display: flex;
		gap: 8px;
	}

	/* The status glyph's 16px slot, one line box tall: the message starts on
	   the check name's column and the icon centres on its first line. */
	.annotation-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 16px;
		height: 1.25rem;
	}

	.annotation--failure .annotation-icon {
		color: var(--color-danger);
	}

	.annotation--warning .annotation-icon {
		color: var(--color-warning);
	}

	.annotation--notice .annotation-icon {
		color: var(--color-text-muted);
	}

	.annotation-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.annotation-message {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.25rem;
		color: var(--color-text-primary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.annotation-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 8px;
		margin: 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.annotation-path {
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		font-family: var(--font-mono);
		font-size: inherit;
		color: var(--color-text-secondary);
		text-align: left;
		overflow-wrap: anywhere;
	}

	button.annotation-path {
		cursor: pointer;
	}

	button.annotation-path:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}

	button.annotation-path:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	/* A caption over a borderless code surface, like the app's markdown code
	   blocks: no box-in-a-box inside the checks card. */
	.log {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.log-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.75rem;
	}

	.log-step {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		color: var(--color-text-secondary);
	}

	.log-note {
		color: var(--color-text-muted);
	}

	.log-body {
		max-height: 360px;
		margin: 0;
		padding: 8px 0;
		overflow: auto;
		border-radius: 6px;
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
</style>
