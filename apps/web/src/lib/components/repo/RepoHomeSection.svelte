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
 */

import type { Repository } from "@revv/shared";
import type { Attachment } from "svelte/attachments";
import { ownerPalette } from "$lib/components/repo/owner-palette.svelte";
import RepoActivitySection from "$lib/components/repo/RepoActivitySection.svelte";
import RepoHero from "$lib/components/repo/RepoHero.svelte";
import RepoRecapCard from "$lib/components/repo/RepoRecapCard.svelte";
import RepoTaggedPrs from "$lib/components/repo/RepoTaggedPrs.svelte";

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

const palette = ownerPalette(() => repo);

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
	<RepoHero {repo} palette={palette.current} linked={isFeed} />

	{#if !isFeed || activityMounted}
		<RepoActivitySection repoId={repo.id} palette={palette.current} />
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

	.activity-slot {
		height: 300px;
	}
</style>
