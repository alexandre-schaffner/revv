<script lang="ts">
import RepoGradientAvatar from "./RepoGradientAvatar.svelte";

// Renders the real GitHub owner/org avatar image. Falls back to the generated
// gradient avatar only when there is no avatar URL, or the image fails to load.
interface Props {
  /** Owner login or "owner/name" — used for the fallback gradient + alt text. */
  name: string;
  /** The owner's GitHub avatar (a data URL served by the API), if known. */
  avatarUrl?: string | null;
  size?: number;
  radius?: number;
  class?: string;
}

let { name, avatarUrl = null, size = 18, radius = 999, class: className = "" }: Props = $props();

let failed = $state(false);
</script>

{#if avatarUrl && !failed}
	<img
		src={avatarUrl}
		alt=""
		class="owner-avatar {className}"
		style:width="{size}px"
		style:height="{size}px"
		style:border-radius="{radius}px"
		loading="lazy"
		decoding="async"
		onerror={() => (failed = true)}
	/>
{:else}
	<RepoGradientAvatar fullName={name} {size} {radius} class={className} />
{/if}

<style>
	.owner-avatar {
		flex-shrink: 0;
		object-fit: cover;
		background: var(--color-bg-elevated);
	}
</style>
