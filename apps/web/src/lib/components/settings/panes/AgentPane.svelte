<script module lang="ts">
import Robot from "phosphor-svelte/lib/Robot";
import { agentReadiness } from "$lib/agent-setup/readiness";
import { fetchAgentStatus, getAgentStatus, getSettings } from "$lib/stores/settings.svelte";
import { defineSettingsPane } from "../settings-panes";

export const pane = defineSettingsPane({
  id: "ai",
  title: "AI agent",
  description: "The coding agent that writes walkthroughs and answers in chat.",
  icon: Robot,
  rows: {
    provider: {
      label: "Agent",
      keywords: ["provider", "claude code", "codex", "opencode", "cursor", "install", "sign in"],
    },
    reviewModel: { label: "Review model", keywords: ["model", "opus", "sonnet", "gpt", "llm"] },
    thinkingEffort: {
      label: "Thinking effort",
      keywords: ["reasoning", "ultrathink", "effort", "depth"],
    },
    suggestionsModel: {
      label: "Suggestions model",
      keywords: ["prompts", "cheap", "haiku", "right panel"],
    },
    maxTurns: { label: "Max turns", keywords: ["limit", "tool calls", "budget", "steps"] },
    baseConflictStrategy: {
      label: "Resolve base conflicts by",
      keywords: ["merge", "rebase", "conflicts", "base branch", "update branch", "force push"],
    },
    agentTest: {
      label: "Test the agent",
      keywords: ["connection", "keychain", "login", "credentials", "check access"],
    },
  },
  badge: () => {
    const status = getAgentStatus()?.agents[getSettings().aiAgent];
    if (!status || agentReadiness(status).ready) return null;
    return { kind: "attention", title: "The selected agent needs setup" };
  },
  onModalOpen: () => void fetchAgentStatus(),
});
</script>

<script lang="ts">
import type { AgentCheckResult } from "@revv/shared";
import {
  ACP_AGENTS,
  type AcpAgentId,
  AI_MAX_TURNS,
  AUTO_SENTINEL,
  type BaseConflictStrategy,
  type ThinkingEffortSetting,
} from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Spinner from "phosphor-svelte/lib/Spinner";
import { Button } from "$lib/components/ui/button/index.js";
import { SegmentedControl, type SegmentedOption } from "$lib/components/ui/segmented-control";
import * as Select from "$lib/components/ui/select";
import { selectAgent } from "$lib/agent-setup/store.svelte";
import {
  fetchModels,
  getAvailableModels,
  getReviewModelOptions,
  getThinkingEffortOptions,
  isAutoEffortOffered,
  isAutoModelOffered,
  type ModelOption,
  runAgentCheck,
  updateSettings,
} from "$lib/stores/settings.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import StatusDot from "../primitives/StatusDot.svelte";
import Stepper from "../primitives/Stepper.svelte";
import AgentProviderList from "./AgentProviderList.svelte";

const conflictStrategy = $derived<BaseConflictStrategy>(
  getSettings().baseConflictStrategy,
);
const conflictStrategyOptions: SegmentedOption<BaseConflictStrategy>[] = [
  { value: "merge", label: "Merge" },
  { value: "rebase", label: "Rebase" },
];
const conflictStrategyHints: Record<BaseConflictStrategy, string> = {
  merge: "Merges the base branch into the PR and pushes. History is kept; a merge commit is added.",
  rebase:
    "Replays the PR onto the base branch and force-pushes (with lease). History is rewritten.",
};

const aiAgent = $derived(getSettings().aiAgent);
const agentLabel = $derived(ACP_AGENTS.find((a) => a.id === aiAgent)?.label ?? "agent");

let statusLoading = $state(false);

async function refreshStatus(options: { refresh?: boolean } = {}): Promise<void> {
  statusLoading = true;
  try {
    await fetchAgentStatus(options);
  } finally {
    statusLoading = false;
  }
}

$effect(() => {
  void refreshStatus();
});

// Populate the model dropdowns for the current agent (boot prefetch usually
// covers this; this backstops a cold cache).
$effect(() => {
  void fetchModels(aiAgent);
});

let agentChecking = $state(false);
let lastCheck = $state<{ agent: AcpAgentId; result: AgentCheckResult } | null>(null);
const agentCheck = $derived(lastCheck?.agent === aiAgent ? lastCheck.result : null);

async function handleRunAgentCheck(): Promise<void> {
  const agent = aiAgent;
  agentChecking = true;
  try {
    lastCheck = { agent, result: await runAgentCheck(agent) };
  } finally {
    agentChecking = false;
  }
}

const AUTO_LABEL = "Auto (sized per pull request)";
const AUTO_OPTION: ModelOption = { label: AUTO_LABEL, value: AUTO_SENTINEL };
const AUTO_EFFORT: { label: string; value: ThinkingEffortSetting } = {
  label: AUTO_LABEL,
  value: AUTO_SENTINEL,
};

const reviewModelOptions = $derived<ModelOption[]>([
  ...(isAutoModelOffered(aiAgent) ? [AUTO_OPTION] : []),
  ...getReviewModelOptions(aiAgent),
]);
const reviewModel = $derived(getSettings().aiModel);

// Hidden, Auto included, for an agent with no effort knob — as in the chat bar.
const agentEfforts = $derived(getThinkingEffortOptions(aiAgent));
const effortOptions = $derived<{ label: string; value: ThinkingEffortSetting }[]>([
  ...(isAutoEffortOffered() ? [AUTO_EFFORT] : []),
  ...agentEfforts,
]);
const effort = $derived(getSettings().aiThinkingEffort);

const suggestionsOptions = $derived(getAvailableModels(aiAgent));
const suggestionsModel = $derived(getSettings().aiSuggestionsModel);

function labelIn(options: readonly { label: string; value: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? (value || "Select…");
}
</script>

<SettingsPane {pane}>
	<SettingsGroup heading="Agent">
		{#snippet actions()}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => refreshStatus({ refresh: true })}
				disabled={statusLoading}
				aria-label="Check agent status again"
				title="Check again"
			>
				{#if statusLoading}
					<Spinner size={13} class="motion-essential-spin" />
				{:else}
					<ArrowsClockwise size={13} />
				{/if}
			</Button>
		{/snippet}
		<AgentProviderList
			row={pane.rows.provider}
			selected={aiAgent}
			status={getAgentStatus()}
			loading={statusLoading}
			onSelect={selectAgent}
		/>
	</SettingsGroup>

	<SettingsGroup heading="Defaults" description="What new reviews and chats start with. The chat bar can change them too.">
		<SettingsRow row={pane.rows.reviewModel} label="Review model" hint="Writes walkthroughs and answers in chat.">
			{#snippet control()}
				<Select.Root
					type="single"
					value={reviewModel}
					onValueChange={(v) => {
						if (v) void updateSettings({ aiModel: v });
					}}
				>
					<Select.Trigger class="w-48 text-xs" aria-label="Review model">
						<span class="truncate">{labelIn(reviewModelOptions, reviewModel)}</span>
					</Select.Trigger>
					<Select.Content class="max-h-80">
						{#each reviewModelOptions as opt (opt.value)}
							<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/snippet}
		</SettingsRow>

		{#if agentEfforts.length > 0}
			<SettingsRow row={pane.rows.thinkingEffort} label="Thinking effort" hint="How long the agent deliberates before it answers.">
				{#snippet control()}
					<Select.Root
						type="single"
						value={effort}
						onValueChange={(v) => {
							const next = effortOptions.find((o) => o.value === v);
							if (next) void updateSettings({ aiThinkingEffort: next.value });
						}}
					>
						<Select.Trigger class="w-48 text-xs" aria-label="Thinking effort">
							<span class="truncate">{labelIn(effortOptions, effort)}</span>
						</Select.Trigger>
						<Select.Content>
							{#each effortOptions as opt (opt.value)}
								<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{/snippet}
			</SettingsRow>
		{/if}

		<SettingsRow
			row={pane.rows.suggestionsModel}
			label="Suggestions model"
			hint="A low-cost model for the suggested prompts in the right panel."
		>
			{#snippet control()}
				<Select.Root
					type="single"
					value={suggestionsModel}
					onValueChange={(v) => {
						if (v) void updateSettings({ aiSuggestionsModel: v });
					}}
				>
					<Select.Trigger class="w-48 text-xs" aria-label="Suggestions model">
						<span class="truncate">{labelIn(suggestionsOptions, suggestionsModel)}</span>
					</Select.Trigger>
					<Select.Content class="max-h-80">
						{#each suggestionsOptions as opt (opt.value)}
							<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/snippet}
		</SettingsRow>

		<SettingsRow
			row={pane.rows.maxTurns}
			label="Max turns"
			hint="Most tool round trips the agent may take in one review or chat reply ({AI_MAX_TURNS.min}–{AI_MAX_TURNS.max})."
		>
			{#snippet control()}
				<Stepper
					id="ai-max-turns-input"
					aria-label="Max turns"
					value={getSettings().aiMaxTurns}
					min={AI_MAX_TURNS.min}
					max={AI_MAX_TURNS.max}
					step={10}
					onCommit={(n) => void updateSettings({ aiMaxTurns: n })}
				/>
			{/snippet}
		</SettingsRow>

		<SettingsRow
			row={pane.rows.baseConflictStrategy}
			label="Resolve base conflicts by"
			hint={conflictStrategyHints[conflictStrategy]}
		>
			{#snippet control()}
				<SegmentedControl
					aria-label="Resolve base conflicts by"
					options={conflictStrategyOptions}
					value={conflictStrategy}
					onValueChange={(v) => void updateSettings({ baseConflictStrategy: v })}
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup heading="Connection">
		<SettingsRow
			row={pane.rows.agentTest}
			label="Test the agent"
			hint="Sends one short prompt with your review model, from Revv's background service, the same way walkthroughs run. Uses a few tokens."
		>
			{#snippet control()}
				<Button size="sm" variant="secondary" disabled={agentChecking} onclick={handleRunAgentCheck}>
					{#if agentChecking}
						<Spinner size={12} class="motion-essential-spin" />
						Testing…
					{:else}
						Run test
					{/if}
				</Button>
			{/snippet}
			{#if agentCheck?.ok}
				<StatusDot tone="success" label="{agentLabel} answered. Walkthroughs can run." />
			{:else if agentCheck}
				<div class="agent-check-failure">
					<StatusDot tone="warning" label="{agentLabel} couldn't run" />
					<code class="agent-check-error">{agentCheck.error}</code>
					{#if agentCheck.guidance}
						<span class="agent-check-guidance">{agentCheck.guidance}</span>
					{/if}
				</div>
			{/if}
		</SettingsRow>
	</SettingsGroup>
</SettingsPane>

<style>
	.agent-check-failure {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 60ch;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.agent-check-error {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--color-text-primary);
	}

	.agent-check-guidance {
		white-space: pre-line;
	}
</style>
