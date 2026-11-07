<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import GenActionBar from "$lib/components/shared/GenActionBar.svelte";
import type { GenActionCopy } from "$lib/components/shared/gen-action";
import { RECAP_PERIOD_COPY } from "$lib/recaps/copy";
import type { RecapController } from "./recap-controller.svelte";
import RecapGeneratePill from "./RecapGeneratePill.svelte";

/**
 * The floating actions over a recap, shown in the shell while this is
 * mounted: Stop / Regenerate for the recap on screen, and, when that recap
 * covers an older window, a way to ask for the current one, which otherwise
 * sits thousands of pixels up the page.
 */
interface Props {
  controller: RecapController;
  period: RecapPeriod;
  /** A recap of the current window was asked for. */
  ongenerated?: ((recapId: string) => void) | undefined;
}

let { controller, period, ongenerated }: Props = $props();

const GEN_COPY: GenActionCopy = {
  regenerate: "Write this recap again, with everything that has happened since",
  stale: "Write this recap again for the same window",
};

const current = $derived(RECAP_PERIOD_COPY[period].current);

useShellChrome(() => ({ actions: controller.hasActions ? actions : undefined }));

async function generateCurrent(): Promise<void> {
  const result = await controller.generate(period);
  if (result) ongenerated?.(result.recapId);
}
</script>

{#snippet actions()}
	<div class="actions-float">
		<div class="actions-row" role="toolbar" aria-label="Recap actions">
			{#if controller.offersCurrentWindow}
				<RecapGeneratePill
					label="Generate {current} recap"
					busyLabel="Generating {current} recap…"
					title="Write a brand-new recap for {current} {period} window. The recap below stays as-is."
					run={generateCurrent}
				/>
			{/if}
			{#if controller.actionState}
				<GenActionBar
					uiState={controller.actionState}
					pendingAction={controller.pendingAction}
					copy={GEN_COPY}
					onStop={() => controller.stop()}
					onRegenerate={() => controller.regenerate()}
				/>
			{/if}
		</div>
	</div>
{/snippet}
