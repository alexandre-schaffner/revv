<script lang="ts">
/*
 * RepoHero — the head of a repo's homepage, printed as a plate: the repo's
 * own engraved landscape, in one ink taken from the owner's avatar hue, by
 * day in the light theme and by night in the dark one, with the title
 * printed over the sky.
 *
 * The heading level and whether the title links back to the repo's own page
 * follow the caller: it does in the `/` feed, where the section is one entry
 * in a stack; it doesn't on the page it already is.
 */

import type { Repository } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import RepoEngraving, { PLATE_TURN, plateTurns } from "$lib/components/repo/RepoEngraving.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Button } from "$lib/components/ui/button";
import { afterPaint, gsap } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import type { OwnerPalette } from "$lib/utils/avatarPalette";
import { repoInk } from "$lib/utils/repo-ink";

interface Props {
  repo: Repository;
  /** The owner's palette, which the activity heatmap under the hero shares. */
  palette: OwnerPalette;
  /** `<h2>` linking to the repo's page, rather than a plain `<h1>`. */
  linked: boolean;
}

let { repo, palette, linked }: Props = $props();

const ink = $derived(repoInk(palette, getResolvedTheme()));
/** The light theme gets the day plate, the dark theme the night one. */
const time = $derived(getResolvedTheme() === "light" ? "day" : "night");
const sky = $derived(time === "day" ? ink.paper : ink.ink);
const mark = $derived(time === "day" ? ink.ink : ink.paper);

/*
 * The hero's sky and marking colours. Set once, then tweened on change at the
 * pace the plate itself turns (`RepoEngraving`), so the title and button
 * turn with the sky instead of flipping ahead of it.
 */
let heroEl = $state<HTMLElement | null>(null);
let shownColours: { sky: string; mark: string } | null = null;

$effect(() => {
  const el = heroEl;
  const next = { sky, mark };
  if (!el) return;
  const prev = shownColours;
  shownColours = next;
  const same = prev?.sky === next.sky && prev.mark === next.mark;
  if (!prev || same || !plateTurns()) {
    gsap.set(el, { "--plate-sky": next.sky, "--plate-mark": next.mark });
    return;
  }
  // From whatever is on screen, so a switch mid-fade turns back smoothly.
  return afterPaint(() => {
    gsap.to(el, {
      "--plate-sky": next.sky,
      "--plate-mark": next.mark,
      ...PLATE_TURN,
      overwrite: "auto",
    });
  });
});

let textWidth = $state(0);
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
		<Button href="/repo/{repo.id}/recaps" variant="outline" size="sm" class="tagged-hero-action" data-glass>
			<CalendarDots size={13} />
			Recaps
		</Button>
	</div>
</div>

<style>
	/* The plate. Its height is the composition's: the engraving keeps the top
	   ~40% as open sky for the title, so this can't shrink much before the
	   ridges climb into the text. `--plate-sky` is the sky's colour and
	   `--plate-mark` whatever is printed on it: ink sky and paper marks by
	   night, the reverse by day. */
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

	/* An outline button printed in the plate's marking colour, so it belongs to it. */
	/* No CSS transition: the Button base's `transition-all` would chase every
	   frame of the hero's colour tween and trail the sky by its duration. */
	.hero :global(.tagged-hero-action) {
		flex-shrink: 0;
		transition: none;
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
