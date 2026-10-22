<script lang="ts">
import User from "phosphor-svelte/lib/User";
import UsersThree from "phosphor-svelte/lib/UsersThree";

/** The 18px leading mark of a person or team row in a filter popover. */
interface Props {
  kind: "user" | "team";
  /** Avatar data URL; a person without one gets the generic glyph. */
  content?: string | null;
}

let { kind, content = null }: Props = $props();

let failed = $state(false);
$effect(() => {
  content;
  failed = false;
});
</script>

{#if kind === 'user' && content && !failed}
	<img
		src={content}
		alt=""
		class="avatar"
		loading="lazy"
		referrerpolicy="no-referrer"
		onerror={() => (failed = true)}
	/>
{:else}
	<span class="avatar avatar--fallback" aria-hidden="true">
		{#if kind === 'team'}<UsersThree size={11} />{:else}<User size={10} />{/if}
	</span>
{/if}

<style>
	.avatar {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		object-fit: cover;
	}

	.avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
	}
</style>
