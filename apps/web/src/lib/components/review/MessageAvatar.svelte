<script lang="ts">
import type { ThreadMessage } from "@revv/shared";
import Avatar from "$lib/components/shared/Avatar.svelte";

interface Props {
  msg: ThreadMessage;
}

let { msg }: Props = $props();
</script>

<div class="avatar" title={msg.authorName}>
	<Avatar
		src={msg.authorRole === 'ai_agent' ? null : msg.authorAvatarContent}
		name={msg.authorName}
		size={22}
		fallback={msg.authorRole === 'ai_agent' ? 'robot' : 'user'}
		glyphSize={14}
	/>
</div>

<style>
	.avatar {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--color-bg-elevated);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}
</style>
