<script lang="ts" module>
import type { ReviewVerdict } from "@revv/shared";

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approved: "Approved",
  changes_requested: "Requested changes",
  commented: "Commented",
  dismissed: "Dismissed",
};
</script>

<script lang="ts">
import ChatCircle from "phosphor-svelte/lib/ChatCircle";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import GitDiff from "phosphor-svelte/lib/GitDiff";
import Prohibit from "phosphor-svelte/lib/Prohibit";

interface Props {
  verdict: ReviewVerdict;
  size?: number;
}

let { verdict, size = 16 }: Props = $props();
</script>

<span class="verdict verdict--{verdict}" role="img" aria-label={VERDICT_LABEL[verdict]}>
	{#if verdict === 'approved'}
		<CheckCircle {size} weight="fill" />
	{:else if verdict === 'changes_requested'}
		<GitDiff {size} weight="bold" />
	{:else if verdict === 'commented'}
		<ChatCircle {size} />
	{:else}
		<Prohibit {size} />
	{/if}
</span>

<style>
	.verdict {
		display: inline-flex;
		flex-shrink: 0;
	}

	.verdict--approved {
		color: var(--color-success);
	}

	.verdict--changes_requested {
		color: var(--color-danger);
	}

	.verdict--commented,
	.verdict--dismissed {
		color: var(--color-text-muted);
	}
</style>
