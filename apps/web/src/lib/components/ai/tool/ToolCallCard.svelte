<script lang="ts" module>
import type { ActivityKind } from "@revv/shared";

export interface ToolCallCardProps {
  activityKind: ActivityKind;
  toolName: string;
  summary: string;
  /** Raw tool input — file_path, command, pattern, etc. */
  payload?: unknown;
  /** Captured tool output (stdout / result text), once available. */
  output?: string | undefined;
  /** Whether the tool call ended in error. */
  isError?: boolean | undefined;
  /** PR id, required to fetch a file-content peek. */
  prId?: string | undefined;
  /** Streaming/active styling (subtle shimmer on the name). */
  active?: boolean;
  class?: string;
}
</script>

<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import FilePlus from "phosphor-svelte/lib/FilePlus";
import FileText from "phosphor-svelte/lib/FileText";
import FolderOpen from "phosphor-svelte/lib/FolderOpen";
import ListChecks from "phosphor-svelte/lib/ListChecks";
import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import Plugs from "phosphor-svelte/lib/Plugs";
import Terminal from "phosphor-svelte/lib/Terminal";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import Wrench from "phosphor-svelte/lib/Wrench";
import type { Component } from "svelte";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import { cn } from "$lib/utils.js";
import {
  activityCommand,
  activityDetailText,
  activityFilePath,
  activityHasPeek,
  activityLabel,
  activityReadWindow,
} from "$lib/utils/activity-groups";
import { diffLineStats, parseDiffOutput } from "$lib/utils/diff-output";
import { fileIcon } from "$lib/utils/file-icon";
import DiffPeek from "./DiffPeek.svelte";
import FilePeek from "./FilePeek.svelte";
import TerminalPeek from "./TerminalPeek.svelte";
import ToolInput from "./ToolInput.svelte";

let {
  activityKind,
  toolName,
  summary,
  payload,
  output,
  isError = false,
  prId,
  active = false,
  class: className,
}: ToolCallCardProps = $props();

const ICONS: Record<ActivityKind, Component> = {
  "tool.read": FileText,
  "tool.write": FilePlus,
  "tool.edit": PencilSimple,
  "tool.bash": Terminal,
  "tool.grep": MagnifyingGlass,
  "tool.glob": MagnifyingGlass,
  "tool.ls": FolderOpen,
  "tool.todo": ListChecks,
  "tool.mcp": Plugs,
  "tool.other": Wrench,
};

// Per-kind accent so the feed reads at a glance: reads/searches in the brand
// accent, mutations warm (edit) / green (write, bash), the rest muted.
const ICON_COLORS: Record<ActivityKind, string> = {
  "tool.read": "var(--color-accent)",
  "tool.write": "var(--color-success)",
  "tool.edit": "var(--color-warning)",
  "tool.bash": "var(--color-success)",
  "tool.grep": "var(--color-accent)",
  "tool.glob": "var(--color-accent)",
  "tool.ls": "var(--color-text-secondary)",
  "tool.todo": "var(--color-accent)",
  "tool.mcp": "var(--color-accent)",
  "tool.other": "var(--color-text-muted)",
};

const Icon = $derived(ICONS[activityKind] ?? Wrench);
const iconColor = $derived(ICON_COLORS[activityKind] ?? "var(--color-text-muted)");
const label = $derived(activityLabel({ activityKind, toolName, output }));
const detail = $derived(activityDetailText({ activityKind, payload, summary }));
const filePath = $derived(activityFilePath({ activityKind, payload }));
// For a windowed Read, the line range it actually read — narrows the file peek
// from the whole file down to those lines.
const readWindow = $derived(activityReadWindow({ activityKind, payload }));
const command = $derived(activityCommand({ activityKind, payload }));
const peekable = $derived(activityHasPeek({ activityKind, payload, output }));
// Per-extension file-type glyph (matches the sidebar tree) shown inside the
// pill for file tools.
const fileGlyph = $derived(filePath ? fileIcon(filePath) : null);
// Structured edit diff (old/new) captured in the output, when present — drives
// the diff peek and the +/- LOC counts beside the pill.
const diffOut = $derived(parseDiffOutput(output));
const diffStats = $derived(diffOut ? diffLineStats(diffOut) : null);

let open = $state(false);
</script>

{#snippet detailPill()}
	{#if detail}
		<span class="tcc-detail">
			{#if fileGlyph}
				<svg
					class="tcc-detail-icon"
					viewBox="0 0 16 16"
					style={fileGlyph.color ? `color: ${fileGlyph.color}` : undefined}
					aria-hidden="true"
				>
					<use href={`#${fileGlyph.symbolId}`} />
				</svg>
			{/if}
			<span class="tcc-detail-text">{detail}</span>
		</span>
	{/if}
	{#if diffStats && (diffStats.additions || diffStats.deletions)}
		<span class="tcc-stats">
			{#if diffStats.additions}<span class="tcc-add">+{diffStats.additions}</span>{/if}
			{#if diffStats.deletions}<span class="tcc-del">-{diffStats.deletions}</span>{/if}
		</span>
	{/if}
{/snippet}

{#if peekable}
	<div
		class={cn("tcc", className)}
		data-component="tool-call-card"
		data-state={open ? "open" : "closed"}
	>
		<Collapsible bind:open>
			<CollapsibleTrigger class="tcc-trigger" aria-label={`${label} ${detail}`.trim()}>
				<Icon class="tcc-icon" style={`color: ${iconColor}`} weight="regular" aria-hidden="true" />
				<span class="tcc-name" class:tcc-name--active={active}>{label}</span>
				{@render detailPill()}
				{#if isError}
					<WarningCircle class="tcc-error" weight="fill" aria-hidden="true" />
				{/if}
				<CaretDown class="tcc-chevron" aria-hidden="true" />
			</CollapsibleTrigger>
			<CollapsibleContent class="tcc-content">
				{#if open}
					{#if command}
						<TerminalPeek command={command} output={output} isError={isError} />
					{:else if diffOut}
						<DiffPeek path={diffOut.path || filePath || "file"} oldText={diffOut.oldText} newText={diffOut.newText} />
					{:else if filePath && prId}
						<FilePeek
							prId={prId}
							path={filePath}
							fallbackOutput={output}
							offset={readWindow?.offset}
							limit={readWindow?.limit}
						/>
					{:else if output}
						<pre class="tcc-output" class:tcc-output--error={isError}>{output}</pre>
					{:else}
						<ToolInput input={payload} />
					{/if}
				{/if}
			</CollapsibleContent>
		</Collapsible>
	</div>
{:else}
	<div class={cn("tcc tcc--static", className)} data-component="tool-call-card">
		<Icon class="tcc-icon" style={`color: ${iconColor}`} weight="regular" aria-hidden="true" />
		<span class="tcc-name" class:tcc-name--active={active}>{label}</span>
		{@render detailPill()}
	</div>
{/if}

<style>
	.tcc {
		display: block;
		width: 100%;
		border-radius: 0.375rem;
	}

	.tcc--static {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.125rem 0;
	}

	.tcc :global(.tcc-trigger) {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.375rem;
		padding: 0.1875rem 0.25rem;
		border-radius: 0.375rem;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-snap) var(--ease-out-expo);
	}

	.tcc :global(.tcc-trigger:hover) {
		background: color-mix(in srgb, var(--color-muted) 60%, transparent);
	}

	.tcc :global(.tcc-icon) {
		width: 0.875rem;
		height: 0.875rem;
		flex-shrink: 0;
	}

	.tcc-name {
		flex-shrink: 0;
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1.4;
		color: var(--color-text-primary);
	}

	.tcc-name--active {
		color: var(--color-accent);
	}

	.tcc-detail {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		max-width: 100%;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.3125rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 55%, transparent);
		font-size: 0.75rem;
		line-height: 1.5;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-secondary);
	}

	.tcc-detail-icon {
		width: 0.8125rem;
		height: 0.8125rem;
		flex-shrink: 0;
	}

	.tcc-detail-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tcc-stats {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		font-size: 0.75rem;
		font-family: var(--font-mono, monospace);
		font-weight: 500;
	}

	.tcc-add {
		color: var(--color-diff-add-text, var(--color-success));
	}

	.tcc-del {
		color: var(--color-diff-del-text, var(--color-destructive));
	}

	.tcc :global(.tcc-error) {
		width: 0.8125rem;
		height: 0.8125rem;
		flex-shrink: 0;
		color: var(--color-destructive);
	}

	.tcc :global(.tcc-chevron) {
		width: 0.75rem;
		height: 0.75rem;
		flex-shrink: 0;
		margin-left: auto;
		color: var(--color-text-muted);
		transition: transform var(--duration-snap) var(--ease-out-expo);
	}

	.tcc[data-state="open"] :global(.tcc-chevron) {
		transform: rotate(180deg);
	}

	.tcc :global(.tcc-content) {
		overflow: hidden;
		padding: 0.375rem 0 0.125rem;
	}

	.tcc :global(.tcc-content[data-state="closed"]) {
		display: none;
	}

	.tcc-output {
		margin: 0;
		max-height: 20rem;
		overflow: auto;
		padding: 0.625rem 0.75rem;
		border-radius: 0.375rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 50%, transparent);
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--color-text-primary);
	}

	.tcc-output--error {
		color: var(--color-destructive);
	}
</style>
