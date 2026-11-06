<script module lang="ts">
import Download from "phosphor-svelte/lib/Download";
import { defineSettingsPane } from "../settings-panes";

export const pane = defineSettingsPane({
  id: "updates",
  title: "Updates",
  description: "Which releases Revv installs, and the build you're running.",
  icon: Download,
  rows: {
    channel: { label: "Release channel", keywords: ["nightly", "stable", "beta"] },
    check: { label: "Check for updates", keywords: ["upgrade", "version"] },
    build: { label: "App build", keywords: ["commit", "version", "hash"] },
    serviceBuild: { label: "Background service build", keywords: ["server", "commit", "version"] },
  },
});
</script>

<script lang="ts">
import type { UpdateChannel } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import Spinner from "phosphor-svelte/lib/Spinner";
import { fetchRuntimeHealth } from "$lib/api/runtime";
import { compareServiceBuild } from "$lib/updater/service-build";
import { Button } from "$lib/components/ui/button/index.js";
import { SegmentedControl, type SegmentedOption } from "$lib/components/ui/segmented-control";
import { gsapPop } from "$lib/motion";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { getCommitHash } from "$lib/updater/client";
import { runCheck as runUpdaterCheck } from "$lib/updater/service";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";

const commitHash = getCommitHash();
let serviceBuild = $state<{ label: string; mismatch: boolean } | null>(null);

$effect(() => {
  let cancelled = false;
  void fetchRuntimeHealth()
    .then((health) => {
      if (cancelled) return;
      const build = compareServiceBuild(commitHash, health.commit);
      serviceBuild = {
        label:
          build.kind === "mismatch"
            ? (build.serviceCommit ?? "older than this app")
            : (health.commit?.slice(0, 7) ?? "unknown"),
        mismatch: build.kind === "mismatch",
      };
    })
    .catch(() => {
      if (!cancelled) serviceBuild = { label: "unreachable", mismatch: false };
    });
  return () => {
    cancelled = true;
  };
});

const channel = $derived<UpdateChannel>(getSettings().updateChannel);

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

<SettingsPane {pane}>
	<SettingsGroup>
		<SettingsRow row={pane.rows.channel} label="Release channel" hint={channelDescriptions[channel]}>
			{#snippet control()}
				<SegmentedControl
					aria-label="Release channel"
					options={channelOptions}
					value={channel}
					onValueChange={(v) => void updateSettings({ updateChannel: v })}
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow row={pane.rows.check} label="Check for updates" hint="Revv also checks on its own every hour.">
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
		<SettingsRow row={pane.rows.build} label="App build" hint="The commit this app was built from.">
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
		<SettingsRow
			row={pane.rows.serviceBuild}
			label="Background service build"
			hint={serviceBuild?.mismatch
				? 'Does not match this app. Quit Revv from the menu bar icon and open it again.'
				: 'The commit the service that runs reviews and chat was started from.'}
		>
			{#snippet control()}
				<span class="build-hash" class:build-hash-stale={serviceBuild?.mismatch}>
					{serviceBuild?.label ?? '…'}
				</span>
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

	.build-hash-stale {
		color: var(--color-warning);
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
