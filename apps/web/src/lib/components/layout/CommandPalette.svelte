<script lang="ts">
import type { PullRequest, Repository } from "@revv/shared";
import * as Command from "$lib/components/ui/command/index.js";
import {
  fuzzyScore,
  getFilteredCommands,
  resetQuery,
  setQuery as setCommandQuery,
} from "$lib/stores/commands.svelte";
import { getArchivedPrs, getPullRequests, getRepositories, selectPr } from "$lib/stores/prs.svelte";
import { type PaletteMode, setPaletteMode } from "$lib/stores/shortcuts.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";

interface Props {
  open: boolean;
  mode: PaletteMode;
  onOpenChange: (open: boolean) => void;
}

let { open, mode, onOpenChange }: Props = $props();

let inputValue = $state("");

// Reset query state whenever the palette is opened, or the mode flips while
// open. The store-backed `mode` is the source of truth; we only sync local
// input + command-store query off it.
$effect(() => {
  if (!open) return;
  if (mode === "command") {
    inputValue = ">";
    setCommandQuery("");
  } else {
    inputValue = "";
    resetQuery();
  }
});

function handleInputChange(val: string) {
  inputValue = val;
  if (mode === "search" && val.startsWith(">")) {
    setPaletteMode("command");
    setCommandQuery(val.slice(1).trim());
  } else if (mode === "command" && !val.startsWith(">")) {
    setPaletteMode("search");
    setCommandQuery("");
  } else if (mode === "command") {
    setCommandQuery(val.slice(1).trim());
  }
}

// ── PR scoring ───────────────────────────────────────

const repoMap = $derived(new Map<string, Repository>(getRepositories().map((r) => [r.id, r])));

interface PrResult {
  pr: PullRequest;
  repoName: string;
  score: number;
}

function scorePr(pr: PullRequest, q: string): number {
  const repoName = repoMap.get(pr.repositoryId)?.fullName ?? "";
  return Math.max(
    fuzzyScore(q, pr.title),
    fuzzyScore(q, pr.sourceBranch),
    fuzzyScore(q, `#${pr.externalId}`),
    fuzzyScore(q, pr.authorLogin),
    fuzzyScore(q, repoName),
  );
}

const searchQuery = $derived(inputValue.trim());

const openResults = $derived.by((): PrResult[] => {
  if (mode !== "search") return [];
  const prs = getPullRequests();
  if (searchQuery.length === 0) {
    return prs.map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: 0,
    }));
  }
  return prs
    .map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: scorePr(pr, searchQuery),
    }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
});

const archivedResults = $derived.by((): PrResult[] => {
  if (mode !== "search") return [];
  const prs = getArchivedPrs();
  if (searchQuery.length === 0) {
    return prs.map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: 0,
    }));
  }
  return prs
    .map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: scorePr(pr, searchQuery),
    }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
});

const commands = $derived(mode === "command" ? getFilteredCommands() : []);
const hasResults = $derived(
  mode === "search" ? openResults.length + archivedResults.length > 0 : commands.length > 0,
);

function handlePrSelect(pr: PullRequest) {
  onOpenChange(false);
  // Mirror PrItem.handleClick: pair PR selection with sidebar swap to keep
  // header + body in lockstep regardless of entry point.
  selectPr(pr.id);
  setSidebarView("files");
}

function handleCommandSelect(action: () => void) {
  onOpenChange(false);
  action();
}
</script>

<Command.Dialog
  {open}
  {onOpenChange}
  shouldFilter={false}
  title={mode === "command" ? "Command palette" : "Search pull requests"}
  description={mode === "command" ? "Run a command" : "Search and open pull requests"}
>
  <Command.Input
    value={inputValue}
    oninput={(e) => handleInputChange(e.currentTarget.value)}
    placeholder={mode === "command" ? "Type a command..." : "Search pull requests..."}
  />
  <Command.List class="max-h-[340px]">
    {#if mode === "search"}
      {#if openResults.length > 0}
        <Command.Group heading="Open pull requests">
          {#each openResults as result (result.pr.id)}
            <Command.Item
              value={`open-${result.pr.id}`}
              onSelect={() => handlePrSelect(result.pr)}
              class="flex-col items-stretch gap-0.5 py-2"
            >
              <div class="flex w-full min-w-0 items-center gap-2">
                {#if result.pr.authorAvatarContent}
                  <img
                    src={result.pr.authorAvatarContent}
                    alt=""
                    class="size-4 shrink-0 rounded"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                    onerror={(e) =>
                      ((e.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                {/if}
                <span
                  class="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium"
                >
                  {result.pr.title}
                </span>
                <span class="text-muted-foreground shrink-0 text-[11px]">
                  {result.repoName}
                  <span class="ms-1 font-mono">#{result.pr.externalId}</span>
                </span>
              </div>
              <div class="text-muted-foreground truncate ps-6 font-mono text-[11px]">
                {result.pr.sourceBranch}
              </div>
            </Command.Item>
          {/each}
        </Command.Group>
      {/if}
      {#if archivedResults.length > 0}
        <Command.Group heading="Archived pull requests">
          {#each archivedResults as result (result.pr.id)}
            <Command.Item
              value={`archived-${result.pr.id}`}
              onSelect={() => handlePrSelect(result.pr)}
              class="flex-col items-stretch gap-0.5 py-2"
            >
              <div class="flex w-full min-w-0 items-center gap-2">
                {#if result.pr.authorAvatarContent}
                  <img
                    src={result.pr.authorAvatarContent}
                    alt=""
                    class="size-4 shrink-0 rounded"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                    onerror={(e) =>
                      ((e.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                {/if}
                <span
                  class="text-muted-foreground min-w-0 flex-1 truncate text-[13px] font-medium"
                >
                  {result.pr.title}
                </span>
                <span
                  class="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-px text-[9px] font-semibold tracking-wider uppercase"
                >
                  {result.pr.status}
                </span>
                <span class="text-muted-foreground shrink-0 text-[11px]">
                  {result.repoName}
                  <span class="ms-1 font-mono">#{result.pr.externalId}</span>
                </span>
              </div>
              <div class="text-muted-foreground truncate ps-6 font-mono text-[11px]">
                {result.pr.sourceBranch}
              </div>
            </Command.Item>
          {/each}
        </Command.Group>
      {/if}
      {#if !hasResults}
        <Command.Empty forceMount>No matching pull requests</Command.Empty>
      {/if}
    {:else}
      {#each commands as cmd (cmd.id)}
        <Command.Item value={cmd.id} onSelect={() => handleCommandSelect(cmd.action)}>
          <span class="text-foreground text-[13px]">{cmd.label}</span>
          {#if cmd.shortcut}
            <Command.Shortcut>{cmd.shortcut}</Command.Shortcut>
          {/if}
        </Command.Item>
      {/each}
      {#if !hasResults}
        <Command.Empty forceMount>No matching commands</Command.Empty>
      {/if}
    {/if}
  </Command.List>
</Command.Dialog>
