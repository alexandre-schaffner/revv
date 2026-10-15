<script lang="ts">
/*
 * RepoHomeSection — one repo's homepage: hero, the queue of PRs that involve
 * the viewer, and the latest recap.
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
 */

import type { Repository } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import RepoRecapCard from "$lib/components/repo/RepoRecapCard.svelte";
import RepoTaggedPrs from "$lib/components/repo/RepoTaggedPrs.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Button } from "$lib/components/ui/button";

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

/*
 * The recap card is mounted on demand in the feed, immediately on the page.
 *
 * `RepoRecapCard` fetches on mount — the repo's recap list, then the latest
 * recap's full markdown — so mounting one per repo up front turns landing on
 * `/` into two requests and a markdown render per synced repo, all of them for
 * cards that are mostly below the fold. The queue above it costs nothing
 * (it is derived from the PR store), so this is the only part worth deferring.
 *
 * 600px of root margin means the card is already loaded by the time it is
 * scrolled to at any normal speed; the reader sees a card, not a spinner.
 */
let recapSlot = $state<HTMLElement | null>(null);
let recapMounted = $state(false);

$effect(() => {
  if (!isFeed || recapMounted) return;
  const host = recapSlot;
  if (!host) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      recapMounted = true;
      observer.disconnect();
    },
    { rootMargin: "600px 0px" },
  );
  observer.observe(host);
  return () => observer.disconnect();
});
</script>

<section class="repo-home" aria-labelledby="repo-home-{repo.id}">
	<div class="hero">
		<RepoGradientAvatar
			fullName={repo.fullName}
			ownerAvatarUrl={repo.avatarUrl}
			size={48}
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
		<Button href="/repo/{repo.id}/recaps" variant="outline" size="sm" class="tagged-hero-action">
			<CalendarDots size={13} />
			Recaps
		</Button>
	</div>

	<RepoTaggedPrs repoId={repo.id} defaultBranch={repo.defaultBranch} />
	{#if isFeed}
		<div bind:this={recapSlot}>
			{#if recapMounted}<RepoRecapCard repoId={repo.id} />{/if}
		</div>
	{:else}
		<RepoRecapCard repoId={repo.id} />
	{/if}
</section>

<style>
	.repo-home {
		display: flex;
		flex-direction: column;
		gap: 32px;
		min-width: 0;
	}

	.hero {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	:global(.hero-avatar) {
		flex-shrink: 0;
	}

	.hero-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.hero-title {
		font-size: 22px;
		font-weight: 700;
		color: var(--color-text-primary);
		margin: 0;
		line-height: 1.2;
	}

	.hero-link {
		color: inherit;
		text-decoration: none;
	}

	.hero-link:hover {
		text-decoration: underline;
	}

	.hero-link:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 3px;
		border-radius: 3px;
	}

	.hero-owner {
		font-size: 13px;
		color: var(--color-text-muted);
		margin: 0;
		font-family: var(--font-mono, monospace);
	}

	:global(.tagged-hero-action) {
		margin-left: auto;
		flex-shrink: 0;
	}
</style>
