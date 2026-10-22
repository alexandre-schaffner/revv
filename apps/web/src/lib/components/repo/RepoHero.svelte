<script lang="ts">
import type { Repository } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import RepoEngraving from "$lib/components/repo/RepoEngraving.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Button } from "$lib/components/ui/button";
import { gsap, turnLook } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import type { OwnerPalette } from "$lib/utils/avatarPalette";
import { repoInk } from "$lib/utils/repo-ink";

interface Props {
  repo: Repository;
  palette: OwnerPalette;
  /** `<h2>` linking to the repo's page, rather than a plain `<h1>`. */
  linked: boolean;
}

let { repo, palette, linked }: Props = $props();

const ink = $derived(repoInk(palette, getResolvedTheme()));
const time = $derived(getResolvedTheme() === "light" ? "day" : "night");
const sky = $derived(time === "day" ? ink.paper : ink.ink);
const mark = $derived(time === "day" ? ink.ink : ink.paper);

let heroEl = $state<HTMLElement | null>(null);
let shown = false;

$effect(() => {
  const el = heroEl;
  if (!el) return;
  const colours = { "--plate-sky": sky, "--plate-mark": mark };
  if (!shown) {
    shown = true;
    gsap.set(el, colours);
    return;
  }
  const turn = turnLook(el, colours);
  return () => turn.land();
});

let textWidth = $state<number | null>(null);
</script>

<div class="hero" bind:this={heroEl}>
	<RepoEngraving seed={repo.fullName} ink={ink.ink} paper={ink.paper} {textWidth} {time} />
	<div class="hero-content">
		<div class="hero-id" bind:clientWidth={textWidth}>
			<RepoGradientAvatar
				fullName={repo.fullName}
				ownerAvatarUrl={repo.avatarUrl}
				size={44}
				radius={10}
				class="hero-avatar"
			/>
			<div class="hero-text">
				{#if linked}
					<h2 class="hero-title" id="repo-home-{repo.id}">
						<a href="/repo/{repo.id}" class="hero-link">{repo.name}</a>
					</h2>
				{:else}
					<h1 class="hero-title" id="repo-home-{repo.id}">{repo.name}</h1>
				{/if}
				<p class="hero-owner">{repo.owner}/{repo.name}</p>
			</div>
		</div>
		<Button href="/repo/{repo.id}/recaps" variant="outline" size="sm" class="tagged-hero-action transition-none" data-glass>
			<CalendarDots size={13} />
			Recaps
		</Button>
	</div>
</div>

<style>
	.hero {
		position: relative;
		height: 232px;
		border-radius: 14px;
		overflow: hidden;
		isolation: isolate;
		background: var(--plate-sky);
		color: var(--plate-mark);
	}

	.hero-content {
		position: relative;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 24px 24px 0 26px;
	}

	.hero-id {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
		padding-right: 24px;
	}

	:global(.hero-avatar) {
		flex-shrink: 0;
		box-shadow: 0 0 0 2px var(--plate-sky);
	}

	.hero-text {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.hero-title {
		font-size: 24px;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--plate-mark);
		margin: 0;
		line-height: 1.15;
	}

	.hero-link {
		color: inherit;
		text-decoration: none;
	}

	.hero-link:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.hero-link:focus-visible {
		outline: 2px solid var(--plate-mark);
		outline-offset: 3px;
		border-radius: 3px;
	}

	.hero-owner {
		font-size: 12px;
		color: color-mix(in oklab, var(--plate-mark) 72%, transparent);
		margin: 0;
		font-family: var(--font-mono, monospace);
	}

	.hero :global(.tagged-hero-action) {
		flex-shrink: 0;
		background: color-mix(in oklab, var(--plate-sky) 70%, transparent);
		border-color: color-mix(in oklab, var(--plate-mark) 45%, transparent);
		color: var(--plate-mark);
		backdrop-filter: blur(2px);
	}

	.hero :global(.tagged-hero-action:hover) {
		background: color-mix(in oklab, var(--plate-mark) 14%, var(--plate-sky));
		color: var(--plate-mark);
	}
</style>
