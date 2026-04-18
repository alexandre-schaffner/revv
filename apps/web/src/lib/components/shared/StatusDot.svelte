<script lang="ts">
	import type { PullRequestStatus, ReviewStatus } from '@revv/shared';

	let { status, reviewStatus = 'pending' }: { status: PullRequestStatus; reviewStatus?: ReviewStatus } = $props();

	let dotClass = $derived(() => {
		if (status === 'closed') return 'bg-text-muted';
		if (status === 'merged') return 'bg-text-muted';
		switch (reviewStatus) {
			case 'in_progress': return 'bg-warning';
			case 'reviewed': return 'bg-success';
			case 'changes_proposed': return 'bg-[var(--color-ai-accent)]';
			default: return 'bg-accent';
		}
	});
</script>

<span
	class="inline-block h-2 w-2 shrink-0 rounded-full {dotClass()}"
	aria-label="Status: {status}"
></span>
