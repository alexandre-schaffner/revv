<script lang="ts">
import { formatRelativeTime } from "$lib/utils/format-relative-time";

// "3 hours ago", with the exact local time on hover.

interface Props {
  iso: string;
  muted?: boolean;
}

let { iso, muted = false }: Props = $props();
</script>

<time datetime={iso} title={new Date(iso).toLocaleString()} class:muted>{formatRelativeTime(iso)}</time>

<style>
	.muted {
		color: var(--color-text-muted);
	}
</style>
