<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import { Shimmer } from "$lib/components/ai/shimmer";
import GenActionBar from "$lib/components/shared/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import type { RecapController } from "./recap-controller.svelte";

/**
 * The floating actions over a recap: Stop / Resume / Regenerate for the recap
 * on screen, and, when that recap covers an older window, a way to ask for the
 * current one, which otherwise sits thousands of pixels up the page.
 */
interface Props {
  controller: RecapController;
  period: RecapPeriod;
  /** A recap of the current window was asked for. */
  ongenerated?: ((recapId: string) => void) | undefined;
}

let { controller, period, ongenerated }: Props = $props();

const currentWindow = $derived(period === "daily" ? "today's" : "this week's");

async function onGenerate(): Promise<void> {
  const result = await controller.generate(period);
  if (result) ongenerated?.(result.recapId);
}
</script>

{#if controller.offersCurrentWindow || controller.actionState}
	<div class="actions-float">
		<div class="actions-row" role="toolbar" aria-label="Recap actions">
			{#if controller.offersCurrentWindow}
				<GlassPill
					variant="accent"
					onclick={onGenerate}
					disabled={controller.generating}
					title="Write a brand-new recap for {currentWindow} {period} window. The recap below stays as-is."
				>
					{#if controller.generating}
						<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />
					{:else}
						<PenNib size={16} aria-hidden="true" />
					{/if}
					<Shimmer active={!controller.generating}>
						{controller.generating
							? `Generating ${currentWindow} recap…`
							: `Generate ${currentWindow} recap`}
					</Shimmer>
				</GlassPill>
			{/if}
			{#if controller.actionState}
				<GenActionBar
					uiState={controller.actionState}
					pendingAction={controller.pendingAction}
					onStop={() => controller.stop()}
					onResume={() => controller.regenerate()}
					onRegenerate={() => controller.regenerate()}
				/>
			{/if}
		</div>
	</div>
{/if}
