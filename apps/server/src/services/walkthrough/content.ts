// What a walkthrough's content rows are, independent of who writes or reads
// them: their deterministic identities, the row↔DTO codec, the rules a
// finished review is judged by, and the writes more than one path performs.
// The generation tools, the chat-edit tools, the snapshot importer and
// exporter, and the REST reads all go through here, so an id or a rule can
// only be defined once.

import { createHash } from "node:crypto";
import {
  type AcpAgentId,
  type CommentThread,
  type Confidence,
  isAcpAgentId,
  isExternalAgentProvider,
  isLowSignalScore,
  isResolvedIssueStatus,
  normalizeTokenUsage,
  type RatingAxis,
  type RatingCitation,
  type ThreadMessage,
  type Verdict,
  type WalkthroughBlock,
  type WalkthroughIssue,
  type WalkthroughRating,
  type WalkthroughSemanticStep,
  type WalkthroughTokenUsage,
  ZERO_TOKEN_USAGE,
} from "@revv/shared";
import { and, asc, desc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { Db } from "../../db";
import { commentThreads } from "../../db/schema/comment-threads";
import { threadMessages } from "../../db/schema/thread-messages";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { toMessage, toThread } from "../Review";
import type { GenerationProviderConfig } from "../walkthrough-cache-format";

export type WalkthroughRow = typeof walkthroughs.$inferSelect;
type SemanticStepRow = typeof walkthroughSemanticSteps.$inferSelect;
type BlockRow = typeof walkthroughBlocks.$inferSelect;
type IssueRow = typeof walkthroughIssues.$inferSelect;
type RatingRow = typeof walkthroughRatings.$inferSelect;
type ThreadRow = typeof commentThreads.$inferSelect;
type MessageRow = typeof threadMessages.$inferSelect;

// Every content row's id derives from its position or its content, so a
// replayed tool call lands on the row it wrote before (invariant 3), and an
// imported or restack-carried review gets the ids a chat edit will compute.

export function semanticStepId(walkthroughId: string, semanticStepIndex: number): string {
  return `semantic-${walkthroughId}-${semanticStepIndex}`;
}

export function blockId(
  walkthroughId: string,
  semanticStepIndex: number,
  stepIndex: number,
): string {
  return `block-${walkthroughId}-${semanticStepIndex}-${stepIndex}`;
}

/** Global sort key across a walkthrough's blocks. */
export function blockOrder(semanticStepIndex: number, stepIndex: number): number {
  return semanticStepIndex * 10000 + stepIndex;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A concern is the same concern when its title and anchor are. */
export function issueId(
  walkthroughId: string,
  title: string,
  filePath: string | null,
  startLine: number | null,
): string {
  return sha256Hex(`${walkthroughId}\0${title}\0${filePath ?? ""}\0${startLine ?? ""}`);
}

/** One thread per (issue, file, line range, side). */
export function anchorThreadId(
  walkthroughId: string,
  issue: string,
  filePath: string,
  startLine: number,
  endLine: number,
  diffSide: "old" | "new",
): string {
  return sha256Hex(
    `${walkthroughId}\0${issue}\0${filePath}\0${startLine}\0${endLine}\0${diffSide}`,
  );
}

/** An AI issue comment is a thread with exactly one message. */
export function issueCommentMessageId(threadId: string): string {
  return `${threadId}-msg-0`;
}

/** A JSON array column, keeping only the elements `guard` accepts. Corrupt JSON reads as empty. */
export function parseJsonArray<T>(raw: string | null, guard: (value: unknown) => value is T): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

export function decodeStringArray(raw: string | null): string[] {
  return parseJsonArray(raw, isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeCitations(raw: string | null): RatingCitation[] {
  return parseJsonArray(raw, isRecord).flatMap((c) =>
    typeof c.filePath === "string" &&
    typeof c.startLine === "number" &&
    typeof c.endLine === "number"
      ? [
          {
            filePath: c.filePath,
            startLine: c.startLine,
            endLine: c.endLine,
            ...(typeof c.note === "string" ? { note: c.note } : {}),
          },
        ]
      : [],
  );
}

/** The stored block payload, or null when its JSON is corrupt. */
export function decodeBlock(row: Pick<BlockRow, "data">): WalkthroughBlock | null {
  try {
    return JSON.parse(row.data) as WalkthroughBlock;
  } catch {
    return null;
  }
}

export function decodeSemanticStep(row: SemanticStepRow): WalkthroughSemanticStep {
  return {
    semanticStepIndex: row.semanticStepIndex,
    title: row.title,
    summary: row.summary ?? null,
  };
}

export function decodeIssue(row: IssueRow): WalkthroughIssue {
  const resolutionEvidence = decodeStringArray(row.resolutionEvidence);
  return {
    id: row.id,
    severity: row.severity as WalkthroughIssue["severity"],
    title: row.title,
    description: row.description,
    blockIds: decodeStringArray(row.blockIds),
    ...(row.filePath !== null ? { filePath: row.filePath } : {}),
    ...(row.startLine !== null ? { startLine: row.startLine } : {}),
    ...(row.endLine !== null ? { endLine: row.endLine } : {}),
    ...(row.submittedAt !== null ? { submittedAt: row.submittedAt } : {}),
    // Absent, not null, when unscored — exactOptionalPropertyTypes keeps
    // "never scored" from reading as low signal.
    ...(row.advisoryScore !== null
      ? { advisoryScore: row.advisoryScore, lowSignal: isLowSignalScore(row.advisoryScore) }
      : {}),
    ...(isResolvedIssueStatus(row.resolutionStatus)
      ? { resolutionStatus: row.resolutionStatus }
      : {}),
    ...(row.resolutionExplanation !== null
      ? { resolutionExplanation: row.resolutionExplanation }
      : {}),
    ...(resolutionEvidence.length > 0 ? { resolutionEvidence } : {}),
    ...(row.resolvingCommitSha !== null ? { resolvingCommitSha: row.resolvingCommitSha } : {}),
    ...(row.resolvedAt !== null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolvedBy !== null && isExternalAgentProvider(row.resolvedBy)
      ? { resolvedBy: row.resolvedBy }
      : {}),
  };
}

export function decodeRating(row: RatingRow): WalkthroughRating {
  return {
    axis: row.axis as RatingAxis,
    verdict: row.verdict as Verdict,
    confidence: row.confidence as Confidence,
    rationale: row.rationale,
    details: row.details,
    citations: decodeCitations(row.citations),
    blockIds: decodeStringArray(row.blockIds),
  };
}

export function decodeTokenUsage(raw: string | null): WalkthroughTokenUsage {
  if (!raw) return ZERO_TOKEN_USAGE;
  try {
    return normalizeTokenUsage(JSON.parse(raw));
  } catch {
    return ZERO_TOKEN_USAGE;
  }
}

/**
 * Installs that predate the ACP-only transport recorded the driver, not the
 * agent. Their rows and team-cache snapshots still carry these names.
 */
const LEGACY_PROVIDER_AGENT: Readonly<Record<string, AcpAgentId>> = {
  "claude-agent-sdk": "claude-code",
  opencode: "opencode",
  codex: "codex",
};

function providerAgent(value: unknown): AcpAgentId {
  if (typeof value !== "string") return "claude-code";
  return isAcpAgentId(value) ? value : (LEGACY_PROVIDER_AGENT[value] ?? "claude-code");
}

export function decodeProviderConfig(
  raw: string | null,
  modelUsed: string,
): GenerationProviderConfig | null {
  if (!raw) return null;
  try {
    return normalizeProviderConfig(JSON.parse(raw), modelUsed);
  } catch {
    return null;
  }
}

/** A provider snapshot as any version of Revv wrote it, in today's vocabulary. */
export function normalizeProviderConfig(
  value: unknown,
  modelUsed: string,
): GenerationProviderConfig | null {
  if (!isRecord(value)) return null;
  return {
    provider: providerAgent(value.provider),
    model: typeof value.model === "string" ? value.model : modelUsed,
    thinkingEffort: typeof value.thinkingEffort === "string" ? value.thinkingEffort : null,
    contextWindow: typeof value.contextWindow === "string" ? value.contextWindow : null,
    maxTurns: typeof value.maxTurns === "number" ? value.maxTurns : 60,
  };
}

/** One commit of `walkthroughs.pr_commits`, oldest first. */
export interface StoredPrCommit {
  readonly sha: string;
  readonly message: string;
  readonly authorLogin: string | null;
  readonly authorAvatarUrl: string | null;
  readonly date: string | null;
}

const nullableString = (v: unknown): boolean => v === null || typeof v === "string";

function isStoredPrCommit(v: unknown): v is StoredPrCommit {
  return (
    isRecord(v) &&
    typeof v.sha === "string" &&
    typeof v.message === "string" &&
    nullableString(v.authorLogin) &&
    nullableString(v.authorAvatarUrl) &&
    nullableString(v.date)
  );
}

export function decodePrCommits(raw: string | null): StoredPrCommit[] {
  return parseJsonArray(raw, isStoredPrCommit);
}

/** A walkthrough's content rows, each in reading order. */
export interface WalkthroughContentRows {
  readonly semanticSteps: readonly SemanticStepRow[];
  readonly blocks: readonly BlockRow[];
  readonly issues: readonly IssueRow[];
  /** In arrival order; the UI re-orders by `RATING_AXES`. */
  readonly ratings: readonly RatingRow[];
}

export function loadContentRows(db: Db, walkthroughId: string): WalkthroughContentRows {
  return {
    semanticSteps: db
      .select()
      .from(walkthroughSemanticSteps)
      .where(eq(walkthroughSemanticSteps.walkthroughId, walkthroughId))
      .orderBy(asc(walkthroughSemanticSteps.semanticStepIndex))
      .all(),
    blocks: db
      .select()
      .from(walkthroughBlocks)
      .where(eq(walkthroughBlocks.walkthroughId, walkthroughId))
      .orderBy(asc(walkthroughBlocks.semanticStepIndex), asc(walkthroughBlocks.stepIndex))
      .all(),
    issues: db
      .select()
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
      .orderBy(asc(walkthroughIssues.order))
      .all(),
    ratings: db
      .select()
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.walkthroughId, walkthroughId))
      .orderBy(asc(walkthroughRatings.createdAt))
      .all(),
  };
}

/** The inline-comment threads raised on `issueIds`, with their messages oldest first. */
export function loadIssueThreads(
  db: Db,
  issueIds: readonly string[],
): { readonly threads: readonly ThreadRow[]; readonly messages: readonly MessageRow[] } {
  if (issueIds.length === 0) return { threads: [], messages: [] };
  const threads = db
    .select()
    .from(commentThreads)
    .where(inArray(commentThreads.walkthroughIssueId, [...issueIds]))
    .all();
  const messages =
    threads.length === 0
      ? []
      : db
          .select()
          .from(threadMessages)
          .where(
            inArray(
              threadMessages.threadId,
              threads.map((t) => t.id),
            ),
          )
          .orderBy(asc(threadMessages.createdAt))
          .all();
  return { threads, messages };
}

/**
 * The walkthrough chat edits and external agents work on: the PR's newest
 * complete one. Resolved per call, so a session that outlives a regenerate
 * follows it.
 */
export function latestCompleteWalkthrough(db: Db, prId: string): WalkthroughRow | null {
  return (
    db
      .select()
      .from(walkthroughs)
      .where(and(eq(walkthroughs.pullRequestId, prId), eq(walkthroughs.status, "complete")))
      .orderBy(desc(walkthroughs.generatedAt))
      .limit(1)
      .get() ?? null
  );
}

/**
 * An axis counts as rated once it carries prose. Rows seeded by the retired
 * Jev verdict pass have an empty rationale.
 */
export function isRatedAxis(row: Pick<RatingRow, "rationale">): boolean {
  return row.rationale.trim().length > 0;
}

/** A review that ran all four phases and finished, superseded since or not. */
export function finishedReview(): SQL {
  return and(
    inArray(walkthroughs.status, ["complete", "superseded"]),
    eq(walkthroughs.lastCompletedPhase, "D"),
    isNotNull(walkthroughs.completedAt),
  ) as SQL;
}

export interface FindingIdentity {
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/**
 * A local resolution carries to a regenerated concern only when it is
 * byte-for-byte the same finding at the same place; a changed finding reopens.
 */
export function isSameResolvedFinding(
  row: FindingIdentity & { readonly resolutionStatus: string },
  next: FindingIdentity,
): boolean {
  return (
    row.resolutionStatus !== "open" &&
    row.severity === next.severity &&
    row.title === next.title &&
    row.description === next.description &&
    row.filePath === next.filePath &&
    row.startLine === next.startLine &&
    row.endLine === next.endLine
  );
}

/**
 * Words that mark the reviewer-mode opening chapter as the commit-history
 * journey, mapped to the stem the completion gate matches. The prompt lists
 * the words (`{{JOURNEY_KEYWORDS}}`), so the two cannot drift.
 */
export const JOURNEY_CHAPTER_KEYWORDS: Readonly<Record<string, string>> = {
  journey: "journey",
  history: "history",
  "got here": "got here",
  "how we": "how we",
  evolution: "evolution",
  explored: "explor",
  attempts: "attempt",
  origins: "origin",
  trajectory: "trajectory",
  "path to": "path to",
  "came to": "came to",
  "story of": "story of",
  trail: "trail",
};

const JOURNEY_CHAPTER_PATTERN = new RegExp(
  `(${Object.values(JOURNEY_CHAPTER_KEYWORDS).join("|")})`,
  "i",
);

export function isJourneyChapterText(title: string, summary: string | null): boolean {
  return JOURNEY_CHAPTER_PATTERN.test(`${title}\n${summary ?? ""}`);
}

/** The keywords as the agent reads them: `'journey', 'history', …`. */
export function journeyKeywordList(quote: string): string {
  return Object.keys(JOURNEY_CHAPTER_KEYWORDS)
    .map((word) => `${quote}${word}${quote}`)
    .join(", ");
}

export interface MissingInlineComment {
  readonly id: string;
  readonly severity: WalkthroughIssue["severity"];
  readonly title: string;
  readonly filePath: string;
  readonly startLine: number;
}

/**
 * Line-anchored concerns that have no inline comment yet. Every one owes a
 * comment (invariant 12); PR-wide concerns have nowhere to anchor one.
 */
export function findIssuesMissingInlineComment(
  db: Db,
  walkthroughId: string,
): MissingInlineComment[] {
  const anchored = db
    .select({
      id: walkthroughIssues.id,
      title: walkthroughIssues.title,
      severity: walkthroughIssues.severity,
      filePath: walkthroughIssues.filePath,
      startLine: walkthroughIssues.startLine,
    })
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .all()
    .flatMap((i) =>
      i.filePath !== null && i.startLine !== null
        ? [
            {
              id: i.id,
              severity: i.severity as WalkthroughIssue["severity"],
              title: i.title,
              filePath: i.filePath,
              startLine: i.startLine,
            },
          ]
        : [],
    );
  if (anchored.length === 0) return [];

  const commented = new Set(
    db
      .select({ issueId: commentThreads.walkthroughIssueId })
      .from(commentThreads)
      .where(
        inArray(
          commentThreads.walkthroughIssueId,
          anchored.map((i) => i.id),
        ),
      )
      .all()
      .map((r) => r.issueId),
  );
  return anchored.filter((i) => !commented.has(i.id));
}

export function renderMissingInlineCommentError(
  uncommented: readonly MissingInlineComment[],
): string {
  const list = uncommented
    .map((i) => `  - id=${i.id} [${i.severity}] (${i.filePath}:${i.startLine}) "${i.title}"`)
    .join("\n");
  return `Error: ${uncommented.length} line-anchored concern(s) have no inline comment. For each, you MUST also call add_issue_comment with the matching issue_id. Missing:\n${list}\n\nCall add_issue_comment for each, then retry complete_walkthrough.`;
}

// The writes below run inside the caller's transaction.

/** A block named by its position, as the agent addresses it. */
export interface BlockRef {
  readonly semantic_step_index: number;
  readonly step_index: number;
}

/**
 * The ids of the blocks `refs` name, deduplicated, or the refs that name no
 * block. Ids come from the rows, so a review imported before ids were
 * deterministic still resolves.
 */
export function resolveBlockRefs(
  db: Db,
  walkthroughId: string,
  refs: readonly BlockRef[],
): { readonly blockIds: string[] } | { readonly unknown: BlockRef[] } {
  if (refs.length === 0) return { blockIds: [] };
  const key = (semanticStepIndex: number, stepIndex: number) => `${semanticStepIndex}:${stepIndex}`;
  const ids = new Map(
    db
      .select({
        id: walkthroughBlocks.id,
        semanticStepIndex: walkthroughBlocks.semanticStepIndex,
        stepIndex: walkthroughBlocks.stepIndex,
      })
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
        ),
      )
      .all()
      .map((r) => [key(r.semanticStepIndex, r.stepIndex), r.id]),
  );
  const unknown = refs.filter((r) => !ids.has(key(r.semantic_step_index, r.step_index)));
  if (unknown.length > 0) return { unknown };
  return {
    blockIds: [
      ...new Set(refs.map((r) => ids.get(key(r.semantic_step_index, r.step_index)) ?? "")),
    ],
  };
}

export function renderUnknownBlockRefs(unknown: readonly BlockRef[]): string {
  return `Error: block_refs [${unknown
    .map((r) => `{semantic_step_index: ${r.semantic_step_index}, step_index: ${r.step_index}}`)
    .join(", ")}] reference diff blocks that don't exist.`;
}

/**
 * Write the AI comment on an issue at one anchor: the thread once, the
 * message body replaced on a retry. Returns the committed thread and message.
 */
export function upsertIssueComment(
  db: Db,
  params: {
    readonly walkthroughId: string;
    readonly reviewSessionId: string;
    readonly issueId: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly diffSide: "old" | "new";
    readonly body: string;
  },
): { readonly thread: CommentThread; readonly message: ThreadMessage } {
  const threadId = anchorThreadId(
    params.walkthroughId,
    params.issueId,
    params.filePath,
    params.startLine,
    params.endLine,
    params.diffSide,
  );
  const messageId = issueCommentMessageId(threadId);
  const now = new Date().toISOString();
  db.insert(commentThreads)
    .values({
      id: threadId,
      reviewSessionId: params.reviewSessionId,
      filePath: params.filePath,
      startLine: params.startLine,
      endLine: params.endLine,
      diffSide: params.diffSide,
      status: "open",
      createdAt: now,
      walkthroughIssueId: params.issueId,
    })
    .onConflictDoNothing({ target: commentThreads.id })
    .run();
  db.insert(threadMessages)
    .values({
      id: messageId,
      threadId,
      authorRole: "ai_agent",
      authorName: "Revv AI",
      authorLogin: null,
      body: params.body,
      messageType: "comment",
      codeSuggestion: null,
      createdAt: now,
      editedAt: null,
      externalId: null,
    })
    .onConflictDoUpdate({
      target: threadMessages.id,
      set: { body: params.body, editedAt: now },
    })
    .run();

  const thread = db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).get();
  const message = db.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get();
  if (!thread || !message) {
    throw new Error(`issue comment ${threadId} was written but cannot be read back`);
  }
  return { thread: toThread(thread), message: toMessage(message, null) };
}
