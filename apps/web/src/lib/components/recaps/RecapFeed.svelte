<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import GenActionBar from "$lib/components/shared/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Shimmer } from "$lib/components/ui/shimmer";
import {
  fetchRecapFeed,
  fetchRecapFeedMonth,
  generateScopeRecap,
  getRecapFeed,
  getRecapFeedMonthPending,
  type RecapSelection,
  recapFeedKey,
} from "$lib/recaps/feed.svelte";
import {
  formatRecapRange,
  isCurrentPeriod,
  slotKeyFor,
  slotSpan,
  utcDayKey,
} from "$lib/recaps/period-window";
import { stopRecap } from "$lib/recaps/store.svelte";
import { resetRecapStream } from "$lib/recaps/stream.svelte";
import { getTeamsForOrg } from "$lib/stores/org-teams.svelte";
import { getRepositories } from "$lib/stores/repos.svelte";
import DotMatrixLoader from "./DotMatrixLoader.svelte";
import RecapArchivePopover from "./RecapArchivePopover.svelte";
import RecapDetail from "./RecapDetail.svelte";
import RecapHeroBig from "./RecapHeroBig.svelte";
import RecapScopePicker from "./RecapScopePicker.svelte";
import { RecapController } from "./recap-controller.svelte";

const period = $derived<RecapPeriod>(
  page.url.searchParams.get("period") === "daily" ? "daily" : "weekly",
);
const selection = $derived.by<RecapSelection>(() => {
  const repoId = page.url.searchParams.get("repoId") ?? page.params.repoId;
  if (repoId) return { repoId };
  const org = page.url.searchParams.get("org");
  const team = page.url.searchParams.get("team");
  return org && team ? { org, team } : {};
});
const scopeValue = $derived(
  selection.repoId
    ? `repo:${selection.repoId}`
    : selection.team
      ? `team:${selection.org}/${selection.team}`
      : "all",
);
const repos = $derived(getRepositories());
const fallbackTeams = $derived(
  [...new Set(repos.map((repo) => repo.owner))].flatMap((org) =>
    getTeamsForOrg(org).map((team) => ({
      org,
      slug: team.slug,
      name: team.name,
      memberLogins: team.memberLogins,
      repositoryIds: repos
        .filter((repo) => repo.owner.toLowerCase() === org.toLowerCase())
        .map((repo) => repo.id),
    })),
  ),
);
const scopeLabel = $derived(
  selection.repoId
    ? (repos.find((r) => r.id === selection.repoId)?.name ?? "Repository")
    : selection.team
      ? (getTeamsForOrg(selection.org ?? "").find((team) => team.slug === selection.team)?.name ??
        selection.team)
      : "Everything",
);
const key = $derived(recapFeedKey(selection, period));
const feedState = $derived(getRecapFeed(key));
const recaps = $derived(
  feedState.status === "ok"
    ? [...feedState.data.recaps]
        .filter((r) => r.status !== "superseded")
        .sort(
          (a, b) =>
            b.periodStart.localeCompare(a.periodStart) ||
            Number(b.sourceScope?.kind === "all") - Number(a.sourceScope?.kind === "all"),
        )
    : [],
);
const requestedId = $derived(page.url.searchParams.get("recapId"));
const requestedDay = $derived.by(() => {
  const day = page.url.searchParams.get("day");
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) ? day : null;
});
const current = $derived(
  requestedDay
    ? (recaps.find(
        (r) => slotKeyFor(period, utcDayKey(r.periodStart)) === slotKeyFor(period, requestedDay),
      ) ?? null)
    : (recaps.find((r) => r.id === requestedId) ?? recaps[0] ?? null),
);
const controller = new RecapController(
  () => current?.repositoryId ?? "",
  () => current?.id ?? null,
);
const detail = $derived(controller.recap);
const stream = $derived(controller.stream);
const selectedMonthPending = $derived(
  Boolean(requestedDay && getRecapFeedMonthPending(key, requestedDay.slice(0, 7))),
);
const periodLabel = $derived(period === "daily" ? "Daily" : "Weekly");
const currentPeriodLabel = $derived(period === "daily" ? "today's" : "this week's");
const selectedDay = $derived(requestedDay ?? (current ? utcDayKey(current.periodStart) : null));
const showFreshAction = $derived(
  Boolean(
    current &&
      !requestedDay &&
      !requestedId &&
      !isCurrentPeriod(period, utcDayKey(current.periodStart)) &&
      current.status !== "generating",
  ),
);
let action = $state<"generate" | "stop" | null>(null);
let actionError = $state<string | null>(null);
const tabs = [
  { id: "daily", label: "Daily", shortcut: "1" },
  { id: "weekly", label: "Weekly", shortcut: "2" },
];
const genActionState = $derived(controller.actionState);
useShellChrome(() => ({ tabs: { snippet: periodTabs, key: "recaps" }, actions: recapActions }));

$effect(() => {
  const value = selection;
  const cadence = period;
  const cacheKey = key;
  const chosenId = requestedId ?? undefined;
  untrack(() => {
    void cacheKey;
    void fetchRecapFeed(value, cadence, undefined, chosenId);
  });
});
$effect(() => {
  const day = requestedDay;
  const value = selection;
  const cadence = period;
  if (day)
    untrack(() => {
      void fetchRecapFeedMonth(value, cadence, day.slice(0, 7));
    });
});

function navigate(scope: string, cadence: RecapPeriod, recapId?: string, day?: string): void {
  const params = new URLSearchParams({ period: cadence });
  if (scope.startsWith("repo:")) params.set("repoId", scope.slice(5));
  if (scope.startsWith("team:")) {
    const [org, team] = scope.slice(5).split("/");
    if (org && team) {
      params.set("org", org);
      params.set("team", team);
    }
  }
  if (recapId) params.set("recapId", recapId);
  if (day) params.set("day", day);
  actionError = null;
  void goto(`/recaps?${params}`);
}
async function generate(day: string | null = requestedDay): Promise<void> {
  if (action) return;
  action = "generate";
  actionError = null;
  try {
    const selected = current?.sourceScope?.kind === "all" && day === selectedDay ? {} : selection;
    const cadence = period;
    const originalKey = key;
    const id = await generateScopeRecap(
      selected,
      cadence,
      day ? `${day}T00:00:00.000Z` : undefined,
    );
    resetRecapStream(id);
    await fetchRecapFeed(selected, cadence, undefined, id);
    if (key === originalKey) navigate(scopeValue, cadence, id);
  } catch (e) {
    actionError = e instanceof Error ? e.message : "Could not generate recap.";
  } finally {
    action = null;
  }
}
async function stop(): Promise<void> {
  if (!current || action) return;
  action = "stop";
  try {
    await stopRecap(current.id);
    await fetchRecapFeed(selection, period);
  } finally {
    action = null;
  }
}
</script>

<div class="period-page">
  <div class="page">
    <div class="content">
      {#if feedState.status === "loading" || feedState.status === "idle" || (!current && selectedMonthPending)}
        <div class="loader-fullscreen"><DotMatrixLoader label="Loading recaps" /></div>
      {:else if feedState.status === "error"}
        <header class="period-hero">
          <span class="period-eyebrow">{scopeLabel}</span>
          <h1 class="period-title">Couldn’t load recaps</h1>
          <p class="period-lede" role="alert">{feedState.error}</p>
          <div class="period-cta"><GlassPill onclick={() => fetchRecapFeed(selection, period)}>Try again</GlassPill></div>
        </header>
      {:else if current}
        <RecapDetail recap={detail} loading={controller.loading} {period} {stream} filter={selection} {scopeLabel} {fallbackTeams} archive={archivePopover} />
      {:else}
        <div class="empty-page">
          {#if requestedDay}
            <header class="empty-hero">
              <span class="period-eyebrow"><span class="ai-mark" aria-hidden="true"></span>{periodLabel} recap</span>
              <div class="date-row"><h1 class="empty-date">{formatRecapRange(slotSpan(period, requestedDay))}</h1>{@render archivePopover()}</div>
              <span class="time-cap">UTC · {scopeLabel}</span>
            </header>
          {:else}
            <RecapHeroBig recap={null} {period} archive={archivePopover} />
          {/if}
          <div class="empty-card">
            <p class="empty-title">Nothing here for now.</p>
            <p class="empty-hint">No recap for this {period === "daily" ? "day" : "week"} yet. Generate one to follow the topics across your teams, understand what changed, and see what’s worth watching.</p>
          </div>
        </div>
      {/if}
      {#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}
    </div>
  </div>

</div>

{#snippet scopePicker()}
  <RecapScopePicker value={scopeValue} label={scopeLabel} onChange={(value) => navigate(value, period, undefined, selectedDay ?? undefined)} />
{/snippet}

{#snippet archivePopover()}
  {#key key}
    <RecapArchivePopover repoId={selection.repoId ?? ""} {period} {recaps} activeRecapId={current?.id ?? null} initialDayKey={selectedDay ?? undefined}
      onOpenRecap={(recap) => navigate(scopeValue, period, recap.id)}
      onOpenWindow={(day) => navigate(scopeValue, period, undefined, day)}
      onLoadMonth={(month) => { void fetchRecapFeedMonth(selection, period, month); }}
      isMonthPending={(month) => getRecapFeedMonthPending(key, month)} />
  {/key}
{/snippet}

{#snippet generateButton(fresh = false)}
  <GlassPill variant="accent" onclick={() => generate(fresh ? null : requestedDay)} disabled={action !== null || repos.length === 0} title={requestedDay && !fresh ? "Generate a recap for this period" : `Generate ${currentPeriodLabel} recap`}>
    {#if action === "generate"}<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />{:else}<PenNib size={16} aria-hidden="true" />{/if}
    <Shimmer active={action !== "generate"}>{action === "generate" ? "Generating recap…" : requestedDay && !fresh ? "Generate recap" : `Generate ${currentPeriodLabel} recap`}</Shimmer>
  </GlassPill>
{/snippet}

<style>
.period-page { position: relative; height: 100%; overflow: hidden; }
.page { height: 100%; overflow-y: auto; }
.content { padding-top: 66px; }
.loader-fullscreen { display: grid; place-items: center; min-height: calc(100vh - 8rem); width: 100%; }
.period-hero { display: flex; flex-direction: column; align-items: flex-start; gap: .75rem; max-width: calc(var(--recap-measure) + 4rem); width: 100%; margin: 0 auto; padding: 2.5rem 2rem 4rem; }
.period-eyebrow { font-family: var(--font-sans); font-size: var(--text-ui); font-weight: 500; color: var(--color-text-subtle); }
.period-title { margin: 0; text-wrap: balance; font-size: var(--text-4xl); font-weight: 500; letter-spacing: -.02em; line-height: 1.02; color: var(--color-text-primary); }
.period-lede { margin: .25rem 0 0; font-size: var(--text-base); line-height: 1.55; color: var(--color-text-secondary); max-width: 34rem; text-wrap: pretty; }
.empty-page { width: 100%; max-width: calc(var(--recap-measure) + 4rem); margin: 0 auto; padding: 1.5rem 2rem 4.5rem; }
.empty-hero { display: flex; flex-direction: column; gap: .35rem; padding-bottom: 1.5rem; }
.empty-hero .period-eyebrow { display: inline-flex; align-items: center; gap: .5rem; }
.ai-mark { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ai-accent); }
.date-row { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem 1.5rem; min-width: 0; }
.date-row :global(.archive-trigger) { margin-left: auto; flex-shrink: 0; }
.empty-date { margin: 0; font-family: var(--font-serif); font-size: var(--text-5xl); font-weight: 500; letter-spacing: -.02em; line-height: 1.05; color: var(--color-text-primary); text-wrap: balance; }
.time-cap { font-size: var(--text-ui); color: var(--color-text-subtle); }
.empty-card { display: flex; flex-direction: column; align-items: center; gap: .5rem; text-align: center; padding: 3rem 2rem; border: 1px dashed color-mix(in srgb, var(--color-text-muted) 30%, transparent); border-radius: .75rem; }
.empty-title { margin: 0; font-size: var(--text-base); font-weight: 500; color: var(--color-text-primary); }
.empty-hint { margin: 0; max-width: 28rem; font-size: var(--text-sm); line-height: 1.55; color: var(--color-text-secondary); text-wrap: pretty; }
.period-cta { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; margin-top: .75rem; }
.action-error { max-width: var(--recap-measure); margin: 1rem auto; padding: 0 2rem; font-size: var(--text-ui); color: var(--color-danger); }
@media (max-width: 720px) { .period-title { font-size: var(--text-3xl); letter-spacing: var(--text-3xl--letter-spacing); } }
</style>

{#snippet periodTabs()}<PillTabs {tabs} activeTab={period} onTabChange={(tab) => navigate(scopeValue, tab === "daily" ? "daily" : "weekly")} trailing={scopePicker} trailingReserve={180} />{/snippet}
{#snippet recapActions()}
  {#if (!current && feedState.status === "ok") || genActionState}
    <div>
      <div class="actions-row" role="toolbar" aria-label="Recap actions">
        {#if !current}{@render generateButton()}{/if}
        {#if showFreshAction}{@render generateButton(true)}{/if}
        {#if genActionState}<GenActionBar uiState={genActionState} pendingAction={action === "generate" ? "regenerate" : action} copy={{regenerate:"Regenerate this recap", stale:"Rerun this recap"}} onStop={stop} onResume={() => generate(selectedDay)} onRegenerate={() => generate(selectedDay)} />{/if}
      </div>
    </div>
  {/if}
{/snippet}
