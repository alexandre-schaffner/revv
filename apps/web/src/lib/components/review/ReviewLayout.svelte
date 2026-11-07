<script lang="ts">
import { isImagePath } from "@revv/shared";
import { onDestroy } from "svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import type { BareBinding, Command } from "$lib/stores/command-keys";
import { useCommands } from "$lib/stores/commands.svelte";
import type { ReviewFile } from "$lib/stores/diff-files.svelte";
import {
  enterLineMode,
  enterScrollMode,
  enterSidebarMode,
  enterVisualMode,
  exitVisualMode,
  type FocusPanel,
  getActivePanel,
  getAnchorLineIndex,
  getCursorLineIndex,
  getTotalLineCount,
  isInDiffMode,
  jumpCursor,
  moveCursor,
} from "$lib/stores/focus-mode.svelte";
import {
  getActiveFilePath,
  getActiveTab,
  setActiveFilePath,
} from "$lib/stores/pr-view-state.svelte";
import { scrollPane } from "$lib/stores/review-nav.svelte";
import DiffViewer from "./DiffViewer.svelte";
import FileFirstPass from "./FileFirstPass.svelte";
import FileIssues from "./FileIssues.svelte";
import ImageDiffViewer from "./ImageDiffViewer.svelte";
import type { CommentRowsTrigger } from "./pierre-diff-adapter";

interface Props {
  prId: string;
  files: readonly ReviewFile[];
}

let { prId, files }: Props = $props();

const activeFilePath = $derived(getActiveFilePath());
const activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);
// Image files: GitHub returns no patch (it's a binary blob), so the diff
// renderer has nothing to render. Route those through the image viewer
// which fetches the bytes for both sides from the local clone. The check
// is path-only — true for renames where one side is an image (the other
// side's bytes will fail with 404 and surface as a per-pane error).
const activeFileIsImage = $derived(
  activeFile !== null &&
    (isImagePath(activeFile.path) ||
      (activeFile.oldPath !== null && isImagePath(activeFile.oldPath))),
);
const activeFileName = $derived.by((): string => {
  if (activeFile) return activeFile.path.split("/").pop() ?? activeFile.path;
  if (activeFilePath) return activeFilePath.split("/").pop() ?? activeFilePath;
  return "";
});

let fileTitleSectionEl = $state<HTMLElement | null>(null);

/** Rows are the cursor's; the diff viewer resolves them to file lines. */
let pendingCommentTrigger = $state<CommentRowsTrigger | null>(null);

function openComment(fromRow: number, toRow: number) {
  pendingCommentTrigger = { fromRow, toRow, seq: Date.now() };
}

let fileTitleVisible = $state(true);

$effect(() => {
  const el = fileTitleSectionEl;
  fileTitleVisible = true;
  if (!el) return;
  const observer = new IntersectionObserver(
    ([entry]) => {
      fileTitleVisible = entry?.isIntersecting ?? true;
    },
    { threshold: 0 },
  );
  observer.observe(el);
  return () => observer.disconnect();
});

useShellChrome(() => ({ subtitle: fileTitleVisible ? null : activeFilePath || null }));

/** Scroll amount per j/k press (in pixels). */
const SCROLL_STEP = 80;

onDestroy(() => {
  // Leaving the Diff tab hands the keyboard back to the sidebar, so the next
  // diff doesn't open in a stale line or visual mode.
  if (getActiveTab() !== "diff") enterSidebarMode();
});

let diffScrollEl = $state<HTMLElement | null>(null);

function navigateFile(direction: 1 | -1) {
  const currentIdx = files.findIndex((f) => f.path === activeFilePath);
  const nextIdx = currentIdx + direction;
  if (nextIdx >= 0 && nextIdx < files.length) {
    // biome-ignore lint/style/noNonNullAssertion: bounds checked above
    setActiveFilePath(files[nextIdx]!.path);
  }
}

function scrollDiff(top: number): void {
  diffScrollEl?.scrollBy({ top, behavior: "instant" });
}

function halfPage(): number {
  return (diffScrollEl?.clientHeight ?? 0) / 2;
}

function scrollDiffTo(edge: "top" | "bottom"): void {
  const el = diffScrollEl;
  if (el) el.scrollTo({ top: edge === "top" ? 0 : el.scrollHeight, behavior: "instant" });
}

const inPanel =
  (...panels: FocusPanel[]) =>
  (): boolean =>
    panels.includes(getActivePanel());
const inDiff = inPanel("diff-scroll", "diff-line", "diff-visual");
const scrollingOrLine = inPanel("diff-scroll", "diff-line");

function diffKey(
  id: string,
  label: string,
  keys: BareBinding,
  when: (() => boolean) | undefined,
  run: () => void,
): Command {
  return { id: `diff:${id}`, label, keys, ...(when ? { when } : {}), hidden: true, run };
}

useCommands([
  diffKey("toggle", "Enter or leave the diff", { bare: [" "] }, undefined, () => {
    if (isInDiffMode()) enterSidebarMode();
    else enterScrollMode();
  }),
  diffKey("leave", "Back to the sidebar", { bare: ["Escape", "h", "t"] }, inDiff, enterSidebarMode),
  diffKey("next-file", "Next file", { bare: ["n"] }, undefined, () => navigateFile(1)),
  diffKey("previous-file", "Previous file", { bare: ["p"] }, undefined, () => navigateFile(-1)),
  diffKey("visual", "Line or visual mode", { bare: ["v"] }, inDiff, () => {
    const panel = getActivePanel();
    if (panel === "diff-visual") exitVisualMode();
    else if (panel === "diff-line") enterVisualMode();
    else enterLineMode(getTotalLineCount());
  }),
  diffKey("down", "Down", { bare: ["j", "ArrowDown"] }, inDiff, () => {
    if (getActivePanel() === "diff-scroll") scrollDiff(SCROLL_STEP);
    else moveCursor(1);
  }),
  diffKey("up", "Up", { bare: ["k", "ArrowUp"] }, inDiff, () => {
    if (getActivePanel() === "diff-scroll") scrollDiff(-SCROLL_STEP);
    else moveCursor(-1);
  }),
  diffKey("half-down", "Half a page down", { bare: ["d"] }, scrollingOrLine, () => {
    if (getActivePanel() === "diff-line") jumpCursor("half-down");
    else scrollDiff(halfPage());
  }),
  diffKey("half-up", "Half a page up", { bare: ["u"] }, scrollingOrLine, () => {
    if (getActivePanel() === "diff-line") jumpCursor("half-up");
    else scrollDiff(-halfPage());
  }),
  diffKey("bottom", "Bottom", { bare: ["G"] }, scrollingOrLine, () => {
    if (getActivePanel() === "diff-line") jumpCursor("bottom");
    else scrollDiffTo("bottom");
  }),
  diffKey("top", "Top", { bare: ["g"], after: "g" }, scrollingOrLine, () => {
    if (getActivePanel() === "diff-line") jumpCursor("top");
    else scrollDiffTo("top");
  }),
  diffKey("comment", "Comment", { bare: ["c"] }, inPanel("diff-line", "diff-visual"), () => {
    const cursor = getCursorLineIndex();
    const from = getActivePanel() === "diff-visual" ? (getAnchorLineIndex() ?? cursor) : cursor;
    openComment(from, cursor);
  }),
]);

const panel = $derived(getActivePanel());
</script>

<div class="relative flex h-full flex-col overflow-hidden bg-bg-primary">
	<div
		class="diff-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
		class:mode-scroll={panel === 'diff-scroll'}
		class:mode-line={panel === 'diff-line'}
		class:mode-visual={panel === 'diff-visual'}
		tabindex="-1"
		role="presentation"
		bind:this={diffScrollEl}
		use:scrollPane={{ prId, pane: "diff" }}
	>
		{#if diffScrollEl}
			{#if activeFile}
				<div class="file-title-section" bind:this={fileTitleSectionEl}>
					<h1 class="file-title">{activeFileName}</h1>
				</div>
				<FileIssues {prId} filePath={activeFile.path} />
				<FileFirstPass {prId} filePath={activeFile.path} patch={activeFile.patch} />
				{#if activeFileIsImage}
					<ImageDiffViewer {prId} file={activeFile} />
				{:else}
					<DiffViewer
						{prId}
						file={activeFile}
						commentTrigger={pendingCommentTrigger}
						scrollRoot={diffScrollEl}
					/>
				{/if}
			{/if}
		{/if}
	</div>

</div>

<style>
	.file-title-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 76px 32px 16px;
		flex-shrink: 0;
	}

	.file-title {
		font-size: 32px;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
		letter-spacing: -0.02em;
		margin: 0;
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}
</style>
