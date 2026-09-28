<script lang="ts">
import {
  ACP_AGENTS,
  type AcpAgentId,
  AUTO_SENTINEL,
  getAgentKeychainAuth,
  type ThinkingEffortSetting,
} from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Spinner from "phosphor-svelte/lib/Spinner";
import { Button } from "$lib/components/ui/button/index.js";
import * as Select from "$lib/components/ui/select";
import type { ModelOption } from "$lib/constants/models";
import { resetAgentSetup } from "$lib/stores/agent-setup.svelte";
import {
  type AgentKeychainResult,
  cascadeChatAgentChange,
  checkAgentKeychain,
  fetchAgentStatus,
  fetchModels,
  getAgentStatus,
  getAvailableModels,
  getReviewModelOptions,
  getSettings,
  getThinkingEffortOptions,
  isAutoEffortOffered,
  isAutoModelOffered,
  updateSettings,
} from "$lib/stores/settings.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import StatusDot from "../primitives/StatusDot.svelte";
import Stepper from "../primitives/Stepper.svelte";
import { SETTINGS_PANES } from "../settings-index";
import AgentProviderList from "./AgentProviderList.svelte";

const MAX_TURNS_MIN = 10;
const MAX_TURNS_MAX = 500;

const aiAgent = $derived(getSettings()?.aiAgent ?? "opencode");
const agentLabel = $derived(ACP_AGENTS.find((a) => a.id === aiAgent)?.label ?? "agent");

// ── Provider status ───────────────────────────────────────────────────────
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

// ── Keychain access ───────────────────────────────────────────────────────
// Shown only for keychain-backed agents (registry-declared); today that's
// Claude Code, but any provider that adds `keychainAuth` surfaces here.
const keychainAuth = $derived(getAgentKeychainAuth(aiAgent));
let keychainChecking = $state(false);
let keychainResult = $state<AgentKeychainResult | null>(null);

async function handleCheckKeychain(): Promise<void> {
  keychainChecking = true;
  try {
    keychainResult = await checkAgentKeychain(aiAgent);
  } finally {
    keychainChecking = false;
  }
}

// An install or sign-in belongs to the agent it started for. Switching agents
// from anywhere (here, or the chat bottom bar) drops it.
let lastAgent: AcpAgentId | null = null;
$effect(() => {
  const agent = aiAgent;
  if (lastAgent !== null && lastAgent !== agent) resetAgentSetup();
  lastAgent = agent;
  keychainResult = null;
});

async function handleSelectAgent(agent: AcpAgentId): Promise<void> {
  await updateSettings(cascadeChatAgentChange(agent));
  void fetchModels(agent);
  void refreshStatus();
}

// ── Defaults ──────────────────────────────────────────────────────────────
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
const reviewModel = $derived(getSettings()?.aiModel ?? "");

// Hidden, Auto included, for an agent with no effort knob — as in the chat bar.
const agentEfforts = $derived(getThinkingEffortOptions(aiAgent));
const effortOptions = $derived<{ label: string; value: ThinkingEffortSetting }[]>([
  ...(isAutoEffortOffered() ? [AUTO_EFFORT] : []),
  ...agentEfforts,
]);
const effort = $derived(getSettings()?.aiThinkingEffort ?? "medium");

const suggestionsOptions = $derived(getAvailableModels(aiAgent));
const suggestionsModel = $derived(getSettings()?.aiSuggestionsModel ?? "");

function labelIn(options: readonly { label: string; value: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? (value || "Select…");
}
</script>

<SettingsPane {...SETTINGS_PANES.ai}>
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
			selected={aiAgent}
			status={getAgentStatus()}
			loading={statusLoading}
			onSelect={handleSelectAgent}
		/>
	</SettingsGroup>

	<SettingsGroup heading="Defaults" description="What new reviews and chats start with. The chat bar can change them too.">
		<SettingsRow id="ai-review-model" label="Review model" hint="Writes walkthroughs and answers in chat.">
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
			<SettingsRow id="ai-thinking-effort" label="Thinking effort" hint="How long the agent deliberates before it answers.">
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
			id="ai-suggestions-model"
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
			id="ai-max-turns"
			label="Max turns"
			hint="Most tool round trips the agent may take in one review or chat reply ({MAX_TURNS_MIN}–{MAX_TURNS_MAX})."
		>
			{#snippet control()}
				<Stepper
					id="ai-max-turns-input"
					aria-label="Max turns"
					value={getSettings()?.aiMaxTurns ?? 60}
					min={MAX_TURNS_MIN}
					max={MAX_TURNS_MAX}
					step={10}
					onCommit={(n) => void updateSettings({ aiMaxTurns: n })}
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	{#if keychainAuth}
		<SettingsGroup heading="Keychain access">
			<SettingsRow
				id="ai-keychain"
				label="Background access"
				hint="Report generation runs in Revv's background service, which needs permission to read your {agentLabel} login from the macOS Keychain."
			>
				{#snippet control()}
					<Button size="sm" variant="secondary" disabled={keychainChecking} onclick={handleCheckKeychain}>
						{#if keychainChecking}
							<Spinner size={12} class="motion-essential-spin" />
							Checking…
						{:else}
							Check access
						{/if}
					</Button>
				{/snippet}
				{#if keychainResult}
					{#if keychainResult.readable === true}
						<StatusDot tone="success" label="Revv can read your {agentLabel} login." />
					{:else if keychainResult.readable === false}
						<p class="keychain-remediation">
							<StatusDot tone="warning" label="Revv can't read it yet" />
							<span>{keychainResult.remediation}</span>
						</p>
					{:else}
						<StatusDot tone="muted" label="Check unavailable on this platform." />
					{/if}
				{/if}
			</SettingsRow>
		</SettingsGroup>
	{/if}
</SettingsPane>

<style>
	.keychain-remediation {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 60ch;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}
</style>
