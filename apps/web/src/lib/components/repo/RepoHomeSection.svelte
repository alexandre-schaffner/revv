<script lang="ts">
/*
 * RepoHomeSection — one repo's homepage: hero, a year of activity, the queue
 * of PRs that involve the viewer, and the latest recap.
 *
 * Two callers, one body. `/repo/[repoId]` renders exactly one of these, and
 * `/` stacks one per synced repo into a scrollable feed so the reader can
 * sweep every project without a trip through the rail. Keeping the body here
 * means the two surfaces can't drift apart.
 *
 * The only variant-sensitive parts are the hero's heading level and whether
 * the title links back to the repo's own page — it does in the feed, where
 * the section is one entry in a stack; it doesn't on the page it already is.
 * The hero scrolls with its section in both, deliberately: a header that
 * pinned itself to the top of the feed was tried and read as chrome.
 *
 * The hero is printed as a plate: the repo's own engraved landscape, in one
 * ink taken from the owner's avatar hue, by day in the light theme and by
 * night in the dark one, with the title printed over the sky. The activity
 * heatmap under it is printed in the same ink, so the section reads as one
 * piece rather than a banner stacked on a dashboard.
 */

import type { Repository } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import { untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import RepoActivitySection from "$lib/components/repo/RepoActivitySection.svelte";
import RepoEngraving from "$lib/components/repo/RepoEngraving.svelte";
import RepoRecapCard from "$lib/components/repo/RepoRecapCard.svelte";
import RepoTaggedPrs from "$lib/components/repo/RepoTaggedPrs.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Button } from "$lib/components/ui/button";
import { afterPaint, gsap, isDocumentCrossfading, prefersReducedMotion, tokens } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import {
  fallbackOwnerPalette,
  type OwnerPalette,
  ownerPaletteFromAvatar,
  peekOwnerPalette,
} from "$lib/utils/avatarPalette";
import { repoInk, repoInkRamp } from "$lib/utils/repo-ink";

interface Props {
  repo: Repository;
  /**
   * `page` — the repo's own route: plain `<h1>`.
   * `feed` — one entry in the `/` stack: `<h2>` linking to that route.
   */
  variant?: "page" | "feed";
}

let { repo, variant = "page" }: Props = $props();

const isFeed = $derived(variant === "feed");

// ── Ink ──────────────────────────────────────────────────────────────────
// Same owner palette the avatar resolves; the session cache means the second
// extraction for an avatar is free.

let resolvedPalette = $state<OwnerPalette | undefined>(undefined);
const palette = $derived(resolvedPalette ?? fallbackOwnerPalette(repo.fullName));

$effect(() => {
  const src = repo.avatarUrl;
  const fallback = fallbackOwnerPalette(repo.fullName);
  return untrack(() => {
    const cached = src ? peekOwnerPalette(src) : undefined;
    resolvedPalette = cached;
    if (!src || cached !== undefined) return;
    let cancelled = false;
    void ownerPaletteFromAvatar(src, fallback).then((p) => {
      if (!cancelled) resolvedPalette = p;
    });
    return () => {
      cancelled = true;
    };
  });
});

const theme = $derived(getResolvedTheme());
const ink = $derived(repoInk(palette, theme));
const ramp = $derived(repoInkRamp(palette, theme));
/** The light theme gets the day plate, the dark theme the night one. */
const time = $derived(theme === "light" ? "day" : "night");
const sky = $derived(time === "day" ? ink.paper : ink.ink);
const mark = $derived(time === "day" ? ink.ink : ink.paper);

/*
 * The hero's sky and marking colours. Set once, then tweened on change at the
 * pace the plate itself crossfades (`RepoEngraving`), so the title and button
 * turn with the sky instead of flipping ahead of it. A theme switch fades the
 * whole page (`crossfadeDocument`), so during one these just swap.
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
  if (!prev || same || prefersReducedMotion() || isDocumentCrossfading()) {
    gsap.set(el, { "--plate-sky": next.sky, "--plate-mark": next.mark });
    return;
  }
  // From whatever is on screen, so a switch mid-fade turns back smoothly.
  return afterPaint(() => {
    gsap.to(el, {
      "--plate-sky": next.sky,
      "--plate-mark": next.mark,
      duration: tokens.ceremonialMedium,
      ease: tokens.easeSoft,
      overwrite: "auto",
    });
  });
});

let heroTextWidth = $state(0);

/*
 * Below-the-fold parts mount on demand in the feed, immediately on the page.
 *
 * The activity chart and `RepoRecapCard` both fetch on mount — the recap
 * card twice, plus a markdown render — so mounting one of each per repo up
 * front turns landing on `/` into a burst of requests per synced repo, all of
 * them for cards that are mostly below the fold. The queue costs nothing
 * (it is derived from the PR store), so it is never deferred.
 *
 * 600px of root margin means a card is already loaded by the time it is
 * scrolled to at any normal speed; the reader sees a card, not a spinner.
 */
let activityMounted = $state(false);
let recapMounted = $state(false);

function mountWhenNear(onNear: () => void): Attachment<HTMLElement> {
  return (host) => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        onNear();
        observer.disconnect();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  };
}
</script>

<section class="repo-home" aria-labelledby="repo-home-{repo.id}">
	<div class="hero" bind:this={heroEl}>
		<RepoEngraving
			seed={repo.fullName}
			ink={ink.ink}
			paper={ink.paper}
			textWidth={heroTextWidth}
			{time}
		/>
		<div class="hero-content">
			<div class="hero-id" bind:clientWidth={heroTextWidth}>
				<RepoGradientAvatar
					fullName={repo.fullName}
					ownerAvatarUrl={repo.avatarUrl}
					size={44}
					radius={10}
					class="hero-avatar"
				/>
				<div class="hero-text">
					{#if isFeed}
						<h2 class="hero-title" id="repo-home-{repo.id}">
							<a href="/repo/{repo.id}" class="hero-link">{repo.name}</a>
						</h2>
					{:else}
						<h1 class="hero-title" id="repo-home-{repo.id}">{repo.name}</h1>
					{/if}
					<p class="hero-owner">{repo.owner}/{repo.name}</p>
				</div>
			</div>
			<Button href="/repo/{repo.id}/recaps" variant="outline" size="sm" class="tagged-hero-action">
				<CalendarDots size={13} />
				Recaps
			</Button>
		</div>
	</div>

	{#if !isFeed || activityMounted}
		<RepoActivitySection repoId={repo.id} {ramp} />
	{:else}
		<div class="activity-slot" {@attach mountWhenNear(() => (activityMounted = true))}></div>
	{/if}

	<RepoTaggedPrs repoId={repo.id} defaultBranch={repo.defaultBranch} />

	{#if !isFeed || recapMounted}
		<RepoRecapCard repoId={repo.id} />
	{:else}
		<div {@attach mountWhenNear(() => (recapMounted = true))}></div>
	{/if}
</section>

<style>
	.repo-home {
		display: flex;
		flex-direction: column;
		gap: 32px;
		min-width: 0;
	}

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

	/* Holds the chart's place while it waits to mount, so the queue below
	   doesn't jump when it arrives. */
	.activity-slot {
		height: 300px;
	}
</style>
