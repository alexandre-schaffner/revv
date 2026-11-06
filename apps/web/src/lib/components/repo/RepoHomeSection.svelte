<script lang="ts">
/*
 * Two callers, one body: `/repo/[repoId]` renders one, and `/` stacks one per
 * synced repo into a feed. The hero scrolls with its section in both: a header
 * pinned to the top of the feed reads as chrome.
 */

import type { Repository } from "@revv/shared";
import type { Attachment } from "svelte/attachments";
import RepoActivitySection from "$lib/components/repo/RepoActivitySection.svelte";
import RepoHero from "$lib/components/repo/RepoHero.svelte";
import RepoRecapCard from "$lib/components/repo/RepoRecapCard.svelte";
import RepoTaggedPrs from "$lib/components/repo/RepoTaggedPrs.svelte";
import { ownerPalette } from "$lib/repos/owner-palette.svelte";

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
 * The activity chart and `RepoRecapCard` fetch on mount (the recap card twice,
 * plus a markdown render), so in the feed they mount on demand rather than
 * turning a landing on `/` into a burst of requests per repo. 600px of root
 * margin loads a card before it is scrolled to at any normal speed.
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
