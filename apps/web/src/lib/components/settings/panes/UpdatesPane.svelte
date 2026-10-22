<script lang="ts">
import type { UpdateChannel } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import Download from "phosphor-svelte/lib/Download";
import Spinner from "phosphor-svelte/lib/Spinner";
import { Button } from "$lib/components/ui/button/index.js";
import { SegmentedControl, type SegmentedOption } from "$lib/components/ui/segmented-control";
import { gsapPop } from "$lib/motion";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { getCommitHash } from "$lib/updater/client";
import { runCheck as runUpdaterCheck } from "$lib/updater/service";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import { SETTINGS_PANES } from "../settings-index";

const commitHash = getCommitHash();
const channel = $derived<UpdateChannel>(getSettings()?.updateChannel ?? "stable");

const channelOptions: SegmentedOption<UpdateChannel>[] = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
];

const channelDescriptions: Record<UpdateChannel, string> = {
  stable: "Vetted releases, announced after a 48-hour safety buffer.",
  nightly: "Every push to main, announced immediately. Expect bugs.",
};

let checking = $state(false);
async function handleCheckNow(): Promise<void> {
  checking = true;
  try {
    await runUpdaterCheck({ manual: true });
  } finally {
    checking = false;
  }
}

const COPIED_HOLD_MS = 1400;
let copied = $state(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

$effect(() => () => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

async function copyHash(): Promise<void> {
  try {
    await navigator.clipboard.writeText(commitHash);
  } catch {
    return;
  }
  copied = true;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied = false;
  }, COPIED_HOLD_MS);
}
</script>

<SettingsPane {...SETTINGS_PANES.updates}>
	<SettingsGroup>
		<SettingsRow id="update-channel" label="Release channel" hint={channelDescriptions[channel]}>
			{#snippet control()}
				<SegmentedControl
					aria-label="Release channel"
					options={channelOptions}
					value={channel}
					onValueChange={(v) => void updateSettings({ updateChannel: v })}
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow id="update-check" label="Check for updates" hint="Revv also checks on its own every hour.">
			{#snippet control()}
				<Button variant="outline" size="sm" onclick={handleCheckNow} disabled={checking}>
					{#if checking}
						<Spinner size={12} class="motion-essential-spin" />
						Checking…
					{:else}
						<Download size={12} />
						Check now
					{/if}
				</Button>
			{/snippet}
		</SettingsRow>
		<SettingsRow id="update-build" label="Build" hint="The commit this build was produced from.">
			{#snippet control()}
				<span class="build-hash">{commitHash}</span>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={copyHash}
					aria-label={copied ? 'Copied' : 'Copy commit hash'}
					title="Copy commit hash"
				>
					<span class="copy-slot">
						{#key copied}
							<span class="copy-glyph" in:gsapPop>
								{#if copied}
									<Check size={13} />
								{:else}
									<Copy size={13} />
								{/if}
							</span>
						{/key}
					</span>
				</Button>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>
</SettingsPane>

<style>
	.build-hash {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.copy-slot {
		position: relative;
		display: inline-block;
		width: 13px;
		height: 13px;
	}

	.copy-glyph {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>
