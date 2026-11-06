<script lang="ts">
import Avatar from "./Avatar.svelte";
import RepoGradientAvatar from "./RepoGradientAvatar.svelte";

// The real GitHub owner/org avatar, or the generated gradient when there is
// no avatar URL or the image fails to load.
interface Props {
  /** Owner login or "owner/name" — used for the fallback gradient. */
  name: string;
  /** The owner's GitHub avatar (a data URL served by the API), if known. */
  avatarUrl?: string | null;
  size?: number;
  radius?: number;
  class?: string;
}

let { name, avatarUrl = null, size = 18, radius = 999, class: className = "" }: Props = $props();
</script>

<Avatar src={avatarUrl} {size} radius="{radius}px" class="owner-avatar {className}">
	{#snippet fallback()}
		<RepoGradientAvatar fullName={name} {size} {radius} class={className} />
	{/snippet}
</Avatar>

<style>
	:global(img.owner-avatar) {
		background: var(--color-bg-elevated);
	}
</style>
