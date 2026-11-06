// Everything the walkthrough tab renders for one PR, derived in one place
// from the walkthrough store, the PR's first pass and the user's settings.
// GuidedWalkthrough only switches on `page.kind` and lays the parts out.

import {
  type Activity,
  chapterNumbersByIndex,
  type IssueSeverity,
  type WalkthroughBlock,
  type WalkthroughIssue,
  type WalkthroughPipelinePhase,
  type WalkthroughSemanticStep,
} from "@revv/shared";
import { untrack } from "svelte";
import type { DotmatrixVariant } from "$lib/components/ui/dotmatrix";
import { getHunkScan } from "$lib/stores/hunk-scan.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { getLoadedHeadSha } from "$lib/stores/review.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import {
  getIsHydrating,
  getSelectedMode,
  getWalkthroughEntry,
} from "$lib/stores/walkthrough.svelte";
import { type WalkthroughEntry, walkthroughUiState } from "$lib/stores/walkthrough-reducer";
import { type GroupableActivity, isExplorationActivity } from "$lib/utils/activity-groups";
import { type FirstPassView, firstPassView } from "$lib/utils/hunk-scan";
import { renderMarkdown } from "$lib/utils/markdown";
import {
  groupIssuesBySeverity,
  type IssueGroup,
  partitionBySignal,
  shouldHideLowSignal,
} from "$lib/utils/walkthrough-issues";
import { WALKTHROUGH_PERSPECTIVES } from "$lib/utils/walkthrough-perspective";

/** Which state the tab is in, in the order the checks apply. */
export type WalkthroughPage =
  | { kind: "error-empty"; explorations: readonly Activity[] }
  | { kind: "cloning"; repoId: string | null }
  | { kind: "empty" }
  | { kind: "first-pass-only" }
  | { kind: "loading" }
  | { kind: "content" }
  | { kind: "none" };

export interface ChapterEntry {
  block: WalkthroughBlock;
  /** The rail annotation of a code/diff/artifact block, rendered once. */
  renderedAnnotation: string | null;
}

export interface Chapter {
  section: WalkthroughSemanticStep;
  /** The printed "Chapter N" — what the chat agent reads as `chapterNumber`. Null for the Overview. */
  number: number | null;
  /** The stepper's jump target, on the chapter that starts its section. */
  anchorId: string | undefined;
  entries: ChapterEntry[];
}

export interface StepperChapterData {
  id: string;
  label: string;
  blurb: string;
  activeBlurb: string;
  spinner: DotmatrixVariant;
  targetId: string;
  available: boolean;
}

export interface IssueCardView {
  issue: WalkthroughIssue;
  /** The block that explains the issue, when it's on the page to jump to. */
  targetBlockId: string | null;
  stepTag: string | null;
}

export type InterleavedActivity =
  | { readonly kind: "thought"; readonly id: string; readonly text: string }
  | {
      readonly kind: "explorations";
      readonly id: string;
      readonly items: readonly GroupableActivity[];
    };

export const FIRST_PASS_SPINNER: DotmatrixVariant = "square-5";

const AGENT_CHAPTERS = [
  {
    id: "overview",
    label: "Overview",
    blurb: "What changed and why",
    activeBlurb: "Reading the diff…",
    spinner: "ripple",
    targetId: "walkthrough-overview",
  },
  {
    id: "diff",
    label: "Diff Analysis",
    blurb: "Hunk-by-hunk reasoning",
    activeBlurb: "Analyzing hunks…",
    spinner: "diagonal",
    targetId: "walkthrough-diff",
  },
  {
    id: "sentiment",
    label: "Sentiment",
    blurb: "Overall read on the PR",
    activeBlurb: "Forming a verdict…",
    spinner: "collapse",
    targetId: "walkthrough-sentiment",
  },
  {
    id: "rated",
    label: "Rating",
    blurb: "Across 9 axes",
    activeBlurb: "Scoring each axis…",
    spinner: "prism-bloom",
    targetId: "walkthrough-rating",
  },
] as const satisfies readonly Omit<StepperChapterData, "available">[];

// The chapter the agent is writing, from `last_completed_phase`: 'A' is the
// overview written and 'B' the first diff step, so both are mid-Diff; 'C' is
// the sentiment, after which the ratings are next.
const PHASE_TO_CHAPTER: Record<WalkthroughPipelinePhase, number> = {
  none: 0,
  A: 1,
  B: 1,
  C: 3,
  D: 3,
};

/** The stepper shows the agent's last few tool calls in the active chapter. */
const TOOL_CALL_WINDOW = 2;

const SEVERITY_RANK: Record<IssueSeverity, number> = { info: 1, warning: 2, critical: 3 };

function annotationOf(block: WalkthroughBlock): string | null {
  return (block.type === "code" || block.type === "diff" || block.type === "artifact") &&
    block.annotation
    ? renderMarkdown(block.annotation)
    : null;
}

function interleave(
  timeline: WalkthroughEntry["timeline"],
  results: WalkthroughEntry["explorationResults"],
  inputs: WalkthroughEntry["explorationInputs"],
): InterleavedActivity[] {
  // Consecutive exploration calls between thoughts read as one group.
  const out: InterleavedActivity[] = [];
  for (const entry of timeline) {
    if (entry.kind === "thought") {
      out.push({ kind: "thought", id: entry.id, text: entry.text });
      continue;
    }
    if (!isExplorationActivity(entry.activity)) continue;
    const callId = entry.activity.callId;
    const result = callId ? results[callId] : undefined;
    const lateInput = callId ? inputs[callId] : undefined;
    const item: GroupableActivity = {
      ...entry.activity,
      id: entry.id,
      ...(lateInput !== undefined ? { payload: lateInput } : {}),
      ...(result ? { output: result.output, isError: result.isError } : {}),
    };
    const last = out.at(-1);
    if (last?.kind === "explorations") {
      out[out.length - 1] = { ...last, items: [...last.items, item] };
    } else {
      out.push({ kind: "explorations", id: `group-${entry.id}`, items: [item] });
    }
  }
  return out;
}

export class WalkthroughView {
  readonly isStreaming: boolean;
  readonly streamError: string | null;
  readonly summary: string | null;
  readonly sentimentHtml: string | null;
  readonly ratings: WalkthroughEntry["ratings"];
  /** Session-unique: entrance motion keys are scoped to it. */
  readonly walkthroughId: string | null;
  readonly isComplete: boolean;

  /** Blocks on the page. Pre-sentiment rows carried the sentiment as a final `## Overall Sentiment` block; once the field exists that copy is dropped. */
  readonly blocks: WalkthroughBlock[];
  readonly overview: Chapter | null;
  readonly chapters: Chapter[];
  readonly chapterCount: number;
  /** The worst severity among the shown issues that point at each block. */
  readonly blockSeverity: ReadonlyMap<string, IssueSeverity>;

  readonly issues: WalkthroughIssue[];
  /** Low-signal issues, folded behind a disclosure. */
  readonly filteredIssues: WalkthroughIssue[];
  readonly issueGroups: (Omit<IssueGroup, "issues"> & { issues: IssueCardView[] })[];
  readonly firstPass: FirstPassView;

  readonly stepperVisible: boolean;
  readonly stepperChapters: StepperChapterData[];
  readonly stepperActiveId: string;
  readonly toolCalls: { step: Activity; ordinal: number }[];
  /** The "Reviewing…" row under the chapters while Phase B can still add to them. */
  readonly showDiffSkeleton: boolean;
  readonly activity: InterleavedActivity[];
  readonly footerParts: string[];
  readonly merged: { at: string | undefined } | null;

  readonly page: WalkthroughPage;

  readonly stepTagFor: (blockId: string) => string | null;

  constructor(prId: () => string) {
    const entry = $derived(getWalkthroughEntry(prId()));
    const hydrating = $derived(getIsHydrating(prId()));
    const blocksAll = $derived(entry?.blocks ?? []);
    const semanticSteps = $derived(entry?.semanticSteps ?? []);
    const allIssues = $derived(entry?.issues ?? []);
    const lastCompletedPhase = $derived(entry?.lastCompletedPhase ?? "none");
    const explorationSteps = $derived(entry?.explorationSteps ?? []);

    this.isStreaming = $derived(entry?.isStreaming ?? false);
    this.streamError = $derived(entry?.streamError ?? null);
    this.summary = $derived(entry?.summary ?? null);
    const sentiment = $derived(entry?.sentiment ?? null);
    this.sentimentHtml = $derived(sentiment ? renderMarkdown(sentiment) : null);
    this.ratings = $derived(entry?.ratings ?? []);
    this.walkthroughId = $derived(entry?.walkthroughId ?? null);
    const uiState = $derived(walkthroughUiState(entry));
    this.isComplete = $derived(uiState.kind === "complete");

    this.blocks = $derived(
      sentiment === null
        ? blocksAll
        : blocksAll.filter(
            (b) =>
              !(b.type === "markdown" && b.content.trimStart().startsWith("## Overall Sentiment")),
          ),
    );

    const entriesByChapter = $derived.by(() => {
      const map = new Map<number, ChapterEntry[]>();
      for (const block of this.blocks) {
        if (block.semanticStepIndex === undefined) continue;
        const list = map.get(block.semanticStepIndex) ?? [];
        list.push({ block, renderedAnnotation: annotationOf(block) });
        map.set(block.semanticStepIndex, list);
      }
      return map;
    });
    // A chapter with no blocks yet (just opened, or left empty by a stalled
    // run) isn't shown and isn't numbered — the same rule the chat agent
    // numbers chapters by.
    const chapterNumbers = $derived(
      chapterNumbersByIndex(
        semanticSteps.map((s) => s.semanticStepIndex),
        entriesByChapter.keys(),
      ),
    );
    this.chapterCount = $derived(chapterNumbers.size);
    this.chapters = $derived(
      semanticSteps
        .filter((s) => chapterNumbers.has(s.semanticStepIndex))
        .map((section, i) => ({
          section,
          number: chapterNumbers.get(section.semanticStepIndex) ?? null,
          anchorId: i === 0 ? "walkthrough-diff" : undefined,
          entries: entriesByChapter.get(section.semanticStepIndex) ?? [],
        })),
    );
    this.overview = $derived(
      this.summary === null
        ? null
        : {
            section: { semanticStepIndex: -1, title: "Overview", summary: null },
            number: null,
            anchorId: "walkthrough-overview",
            entries: [
              {
                block: {
                  type: "markdown",
                  id: "overview-block",
                  order: -1,
                  phase: "overview",
                  stepIndex: 0,
                  content: this.summary,
                },
                renderedAnnotation: null,
              },
            ],
          },
    );

    const blockIndex = $derived(
      new Map(this.blocks.map((b, i) => [b.id, { block: b, step: i + 1 }])),
    );
    this.stepTagFor = (blockId) => {
      const found = blockIndex.get(blockId);
      if (!found) return null;
      const { semanticStepIndex, stepIndex } = found.block;
      if (semanticStepIndex === undefined || stepIndex === undefined) return `→ Step ${found.step}`;
      const chapter = chapterNumbers.get(semanticStepIndex) ?? semanticStepIndex + 1;
      return `→ Ch ${chapter} · Step ${stepIndex + 1}`;
    };

    const signal = $derived(
      partitionBySignal(allIssues, { hideLowSignal: shouldHideLowSignal(getSettings()) }),
    );
    this.issues = $derived(signal.shown);
    this.filteredIssues = $derived(signal.filtered);
    this.issueGroups = $derived(
      groupIssuesBySeverity(this.issues).map((group) => ({
        ...group,
        issues: group.issues.map((issue) => {
          const blockId = issue.blockIds[0] ?? null;
          const stepTag = blockId ? this.stepTagFor(blockId) : null;
          return { issue, targetBlockId: stepTag ? blockId : null, stepTag };
        }),
      })),
    );
    this.blockSeverity = $derived.by(() => {
      const map = new Map<string, IssueSeverity>();
      for (const issue of this.issues) {
        for (const id of issue.blockIds) {
          const current = map.get(id);
          if (!current || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[current]) {
            map.set(id, issue.severity);
          }
        }
      }
      return map;
    });

    // The first pass for the head on screen runs on its own, so it's here
    // before Generate. A stale walkthrough reviewed an older head and can't
    // confirm or miss this head's leads, so it shows none.
    this.firstPass = $derived.by(() => {
      const scan = getHunkScan(prId(), getLoadedHeadSha(prId()));
      const rows = uiState.kind === "complete-stale" ? [] : scan.rows;
      return firstPassView(rows, scan.status, allIssues, !this.isStreaming, entry?.leads ?? null);
    });

    const activeChapterIndex = $derived(
      // Later content is the stronger signal: a missed `phase:advanced`
      // can't strand the stepper on Diff Analysis under rendered ratings.
      this.ratings.length > 0 ? 3 : sentiment !== null ? 2 : PHASE_TO_CHAPTER[lastCompletedPhase],
    );
    // The scan holds the agent until it hands over its leads; a scan that
    // outlives that (past the join budget) no longer holds the stepper.
    const agentStarted = $derived(entry?.leads != null || lastCompletedPhase !== "none");
    this.stepperActiveId = $derived(
      this.firstPass.rows.length > 0 && this.firstPass.running && !agentStarted
        ? "first-pass"
        : (AGENT_CHAPTERS[activeChapterIndex]?.id ?? AGENT_CHAPTERS[0].id),
    );
    this.stepperChapters = $derived.by(() => {
      const written = [
        this.summary !== null,
        this.blocks.length > 0,
        sentiment !== null,
        this.ratings.length > 0,
      ];
      const agent = AGENT_CHAPTERS.map((c, i) => ({ ...c, available: written[i] ?? false }));
      if (this.firstPass.rows.length === 0) return agent;
      return [
        {
          id: "first-pass",
          label: "First pass",
          blurb: this.firstPass.result,
          activeBlurb: this.firstPass.scanning,
          spinner: FIRST_PASS_SPINNER,
          targetId: "walkthrough-first-pass",
          // Its unraised leads fold under the issues, in the content view.
          available: this.summary !== null && this.firstPass.hasLeads,
        },
        ...agent,
      ];
    });
    // Tool calls from an earlier chapter don't carry into the next one.
    const chapterStart = $derived.by(() => {
      void activeChapterIndex;
      return untrack(() => explorationSteps.length);
    });
    this.toolCalls = $derived.by(() => {
      if (this.stepperActiveId === "first-pass") return [];
      const start = Math.max(chapterStart, explorationSteps.length - TOOL_CALL_WINDOW);
      // The absolute index keys each row: two identical `add_diff_step`
      // calls in a row would otherwise collide.
      return explorationSteps.slice(start).map((step, i) => ({ step, ordinal: start + i }));
    });
    this.stepperVisible = $derived(
      !this.streamError &&
        !hydrating &&
        (this.summary !== null || blocksAll.length > 0 || this.isStreaming),
    );

    // Defensive on sentiment/ratings too: any Phase C/D content means Phase B
    // is over even if its `phase:advanced` hasn't arrived.
    this.showDiffSkeleton = $derived(
      this.isStreaming &&
        sentiment === null &&
        this.ratings.length === 0 &&
        (lastCompletedPhase === "none" || lastCompletedPhase === "A" || lastCompletedPhase === "B"),
    );
    this.activity = $derived(
      interleave(
        entry?.timeline ?? [],
        entry?.explorationResults ?? {},
        entry?.explorationInputs ?? {},
      ),
    );

    this.footerParts = $derived.by(() => {
      const parts: string[] = [];
      const by = entry?.generatedBy?.githubLogin;
      const model = entry?.providerConfig?.model;
      if (by) {
        parts.push(`Generated by @${by}`);
        if (model) parts.push(model);
      } else if (model) {
        parts.push(`Generated by ${model}`);
      }
      const effort = entry?.providerConfig?.thinkingEffort;
      if (effort) parts.push(`thinking: ${effort}`);
      const mode = getSelectedMode(prId());
      parts.push(`${WALKTHROUGH_PERSPECTIVES[mode].label.toLowerCase()} perspective`);
      if (entry?.source === "remote") parts.push("loaded from team cache");
      return parts;
    });

    // `getPrById` spans the archive, so a merged PR keeps its stamp.
    this.merged = $derived.by(() => {
      const pr = getPrById(prId());
      return pr?.status === "merged" ? { at: pr.closedAt ?? undefined } : null;
    });

    this.page = $derived.by((): WalkthroughPage => {
      const hasBody = Boolean(this.summary) || blocksAll.length > 0;
      if (this.streamError && !hasBody) {
        return { kind: "error-empty", explorations: explorationSteps.slice(-6) };
      }
      if (entry?.cloneInProgress && !hasBody) {
        return { kind: "cloning", repoId: entry.cloneRepoId };
      }
      if (!this.isStreaming && !hasBody && !this.streamError && !hydrating) {
        return this.firstPass.rows.length > 0 ? { kind: "first-pass-only" } : { kind: "empty" };
      }
      if (!hasBody && sentiment === null && this.ratings.length === 0 && this.isStreaming) {
        return { kind: "loading" };
      }
      if (this.summary) return { kind: "content" };
      return { kind: "none" };
    });
  }
}
