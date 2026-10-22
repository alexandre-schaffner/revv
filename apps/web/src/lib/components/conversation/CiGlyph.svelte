<script lang="ts" module>
import type { CiCheckBucket, CiRollupState } from "@revv/shared";

/** A rollup state, read as the bucket its glyph shares. */
export function bucketOfRollup(state: CiRollupState | null): CiCheckBucket | null {
  switch (state) {
    case "success":
      return "pass";
    case "failure":
    case "error":
      return "fail";
    case "pending":
    case "expected":
      return "pending";
    default:
      return null;
  }
}
</script>

<script lang="ts">
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import MinusCircle from "phosphor-svelte/lib/MinusCircle";
import XCircle from "phosphor-svelte/lib/XCircle";

interface Props {
  bucket: CiCheckBucket;
  size?: number;
}

let { bucket, size = 16 }: Props = $props();

// Shape carries the state as much as color does: a reader who can't tell
// green from red still reads a check, a cross, a dashed ring, a dash.
const LABEL: Record<CiCheckBucket, string> = {
  pass: "Passed",
  fail: "Failed",
  pending: "Pending",
  skip: "Skipped",
};
</script>

<span class="ci-glyph ci-glyph--{bucket}" role="img" aria-label={LABEL[bucket]}>
	{#if bucket === 'pass'}
		<CheckCircle {size} weight="fill" />
	{:else if bucket === 'fail'}
		<XCircle {size} weight="fill" />
	{:else if bucket === 'pending'}
		<CircleDashed {size} weight="bold" />
	{:else}
		<MinusCircle {size} />
	{/if}
</span>

<style>
	.ci-glyph {
		display: inline-flex;
		flex-shrink: 0;
	}

	.ci-glyph--pass {
		color: var(--color-success);
	}

	.ci-glyph--fail {
		color: var(--color-danger);
	}

	.ci-glyph--pending {
		color: var(--color-warning);
	}

	.ci-glyph--skip {
		color: var(--color-text-muted);
	}
</style>
