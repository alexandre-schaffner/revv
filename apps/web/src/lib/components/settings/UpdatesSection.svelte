<script lang="ts">
import type { UpdateChannel } from "@revv/shared";
import Download from "phosphor-svelte/lib/Download";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { Button } from "$lib/components/ui/button/index.js";
import * as Select from "$lib/components/ui/select";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { getCommitHash } from "$lib/updater/client";
import { runCheck as runUpdaterCheck } from "$lib/updater/service";

const commitHash = getCommitHash();
const channel = $derived<UpdateChannel>(getSettings()?.updateChannel ?? "stable");
const channelLabel = $derived(channel === "nightly" ? "Nightly" : "Stable");

let checking = $state(false);
async function handleCheckNow(): Promise<void> {
  checking = true;
  try {
    await runUpdaterCheck({ manual: true });
  } finally {
    checking = false;
  }
}
</script>

<section id="section-updates" class="settings-section">
	<h2 class="section-head-title">Updates</h2>

	<div class="settings-subgroup">
		<div class="settings-row">
			<div class="settings-row-info">
				<p class="settings-row-label">Current build</p>
				<p class="settings-row-hint">Git commit snapshotted when this build was produced.</p>
			</div>
			<span class="font-mono text-xs text-text-secondary">{commitHash}</span>
		</div>

		<div class="settings-row">
			<div class="settings-row-info">
				<p class="settings-row-label">Release channel</p>
				<p class="settings-row-hint">
					Stable ships vetted releases with a 48-hour safety buffer before notifications.
					Nightly tracks every push to <code>main</code> and notifies immediately; expect
					bugs.
				</p>
			</div>
			<Select.Root
				type="single"
				value={channel}
				onValueChange={(v) => {
					if (v === 'stable' || v === 'nightly') {
						void updateSettings({ updateChannel: v });
					}
				}}
			>
				<Select.Trigger class="w-32 text-xs">
					{channelLabel}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="stable" class="text-xs">Stable</Select.Item>
					<Select.Item value="nightly" class="text-xs">Nightly</Select.Item>
				</Select.Content>
			</Select.Root>
		</div>

		<div class="settings-row">
			<div class="settings-row-info">
				<p class="settings-row-label">Check for updates now</p>
				<p class="settings-row-hint">Revv checks automatically every hour.</p>
			</div>
			<Button
				variant="outline"
				size="sm"
				onclick={handleCheckNow}
				disabled={checking}
				class="flex items-center gap-1.5 text-xs hover:border-accent hover:text-text-primary"
			>
				{#if checking}
					<Loader2 size={12} weight="regular" class="motion-essential-spin" />
					Checking…
				{:else}
					<Download size={12} weight="fill" />
					Check now
				{/if}
			</Button>
		</div>
	</div>
</section>

<style>
	.settings-section {
		padding: 32px 36px 28px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.section-head-title {
		font-family: "Newsreader", Georgia, serif;
		font-size: 20px;
		font-weight: 500;
		letter-spacing: -0.01em;
		line-height: 1;
		color: var(--color-text-primary);
		margin-bottom: 22px;
	}

	.settings-subgroup {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.settings-row-info {
		min-width: 0;
		flex: 1;
	}

	.settings-row-label {
		font-size: 13px;
		color: var(--color-text-primary);
	}

	.settings-row-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		margin-top: 2px;
		line-height: 1.45;
	}
</style>
