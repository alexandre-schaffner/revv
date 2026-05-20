<script lang="ts">
import Bot from "phosphor-svelte/lib/Robot";
import User from "phosphor-svelte/lib/User";
import type { ThreadMessage } from "@revv/shared";

interface Props {
  msg: ThreadMessage;
}

let { msg }: Props = $props();

let failed = $state(false);
</script>

<div class="avatar" title={msg.authorName}>
	{#if msg.authorRole === 'ai_agent'}
		<Bot size={14} aria-hidden="true" />
	{:else if msg.authorAvatarUrl && !failed}
		<img
			src={msg.authorAvatarUrl}
			alt={msg.authorName}
			class="avatar-img"
			loading="lazy"
			referrerpolicy="no-referrer"
			onerror={() => { failed = true; }}
		/>
	{:else}
		<User size={14} aria-hidden="true" />
	{/if}
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

	.avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
</style>
