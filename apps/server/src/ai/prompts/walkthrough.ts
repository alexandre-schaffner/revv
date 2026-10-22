import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  HUNK_SMELL_META,
  hunkNewEnd,
  type RatingAxis,
  REVIEW_MODE,
  type RiskLevel,
  type WalkthroughBlock,
  type WalkthroughLead,
  type WalkthroughMode,
  type WalkthroughStackSnapshot,
} from "@revv/shared";
import type { PrFileMeta } from "../../services/GitHub";
import {
  type PromptDiffSource,
  REVERTED_FILE_STATUS,
} from "../../services/walkthrough-prompt-files";

// ── Continuation context (imported here to avoid circular deps) ──────────────
//
// Retained for provider-level bookkeeping (e.g. opencode's session id for
// `--continue`). The agent itself no longer consumes this — per doctrine
// invariant #6, it calls `get_walkthrough_state` via MCP instead.

export interface PromptContinuationContext {
  walkthroughId: string;
  existingBlocks: WalkthroughBlock[];
  existingRatedAxes: RatingAxis[];
}

// ── MCP-based walkthrough prompt (phase-bound, A→B→C→D) ─────────────────────

const WALKTHROUGH_SYSTEM_COMMON_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-system-common.md`,
  "utf-8",
);
const WALKTHROUGH_SYSTEM_REVIEWER_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-system-reviewer.md`,
  "utf-8",
);
const WALKTHROUGH_SYSTEM_AUTHOR_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-system-author.md`,
  "utf-8",
);
const WALKTHROUGH_ARTIFACTS_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-artifacts.md`,
  "utf-8",
);
const WALKTHROUGH_COMMON_PROMPT = readFileSync(`${import.meta.dir}/walkthrough-common.md`, "utf-8");
const WALKTHROUGH_REVIEWER_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-reviewer.md`,
  "utf-8",
);
const WALKTHROUGH_AUTHOR_PROMPT = readFileSync(`${import.meta.dir}/walkthrough-author.md`, "utf-8");

// The common system prompt carries this marker where the perspective-specific
// block belongs (right after the intro, before the pipeline rules) so the mode
// prompt frames the whole document instead of trailing it. Validated at module
// load so a future edit that drops the marker fails fast rather than silently
// emitting a perspective-less system prompt.
const REVIEW_PERSPECTIVE_MARKER = "{{REVIEW_PERSPECTIVE}}";
if (!WALKTHROUGH_SYSTEM_COMMON_PROMPT.includes(REVIEW_PERSPECTIVE_MARKER)) {
  throw new Error(
    `walkthrough-system-common.md is missing the ${REVIEW_PERSPECTIVE_MARKER} marker`,
  );
}

// The artifact craft spec is single-sourced in `walkthrough-artifacts.md` because
// two agents write artifact blocks: the walkthrough author (add_semantic_step /
// add_diff_step) and the chat agent's edit tools (add_block / update_block).
// Substituted into both system prompts so the two can't drift.
export const ARTIFACT_SPEC_MARKER = "{{ARTIFACT_SPEC}}";
export const WALKTHROUGH_ARTIFACT_SPEC: string = WALKTHROUGH_ARTIFACTS_PROMPT.trim();
if (!WALKTHROUGH_SYSTEM_COMMON_PROMPT.includes(ARTIFACT_SPEC_MARKER)) {
  throw new Error(`walkthrough-system-common.md is missing the ${ARTIFACT_SPEC_MARKER} marker`);
}

export function buildWalkthroughSystemPrompt(mode: WalkthroughMode = REVIEW_MODE.reviewer): string {
  const modePrompt =
    mode === REVIEW_MODE.author
      ? WALKTHROUGH_SYSTEM_AUTHOR_PROMPT
      : WALKTHROUGH_SYSTEM_REVIEWER_PROMPT;

  // Replacer functions, not replacement strings: a `$&` or `$'` in a prompt
  // file is a substitution pattern and would splice the surrounding prompt
  // into itself.
  return WALKTHROUGH_SYSTEM_COMMON_PROMPT.replace(REVIEW_PERSPECTIVE_MARKER, () =>
    modePrompt.trim(),
  ).replace(ARTIFACT_SPEC_MARKER, () => WALKTHROUGH_ARTIFACT_SPEC);
}

const WALKTHROUGH_SHARED_REVIEW_PRINCIPLES: string = readFileSync(
  `${import.meta.dir}/walkthrough-shared-review-principles.md`,
  "utf-8",
);

const WALKTHROUGH_INCREMENTAL_REFRESH_PROMPT: string = readFileSync(
  `${import.meta.dir}/walkthrough-incremental-refresh.md`,
  "utf-8",
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Render a tool's path argument relative to the agent's working directory
 * (the per-job git worktree). Agents are handed absolute worktree paths, so
 * the raw `file_path` is a long `/Users/…/worktree/apps/server/…` string that
 * clips in the narrow exploration feed. Relativizing against `cwd` yields the
 * familiar repo-relative form (`apps/server/…`). Falls back to the original
 * path when no `cwd` is supplied, the path isn't absolute (already relative,
 * e.g. Grep's `.`), or it resolves outside the worktree (so we never surface a
 * confusing `../../` escape).
 */
export function toRepoRelative(p: string, cwd?: string): string {
  if (!p || !cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (!rel || rel.startsWith("..")) return p;
  return rel;
}

export function buildExplorationDescription(
  toolName: string,
  input: unknown,
  cwd?: string,
): string {
  const inp = input as Record<string, unknown> | null | undefined;
  const str = (k: string): string => (typeof inp?.[k] === "string" ? (inp[k] as string) : "");
  const path = (k: string): string => toRepoRelative(str(k), cwd);
  switch (toolName) {
    case "Read":
      return `Reading ${path("file_path") || "file"}`;
    case "Grep":
      return `Searching for '${str("pattern")}' in ${path("path") || "codebase"}`;
    case "Glob":
      return `Finding files matching ${str("pattern") || "*"}`;
    case "LS":
      return `Listing ${path("path") || "."}`;
    case "Write":
      return `Wrote ${path("file_path") || "file"}`;
    case "Edit":
      return `Edited ${path("file_path") || "file"}`;
    case "Bash": {
      // Single-line, truncated. The first line of the command is enough
      // signal for the chat panel; full command is in the agent transcript.
      const cmd = str("command");
      if (!cmd) return "Running shell command";
      const firstLine = cmd.split("\n")[0] ?? cmd;
      const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
      return `$ ${truncated}`;
    }
    default:
      return `Using ${toolName}`;
  }
}

/** Human-readable attention tier, for the ranked list and the file headers. */
function tierLabel(tier: number | null): string {
  switch (tier) {
    case 0:
      return "tier 0 · generated";
    case 1:
      return "tier 1 · mechanical";
    case 2:
      return "tier 2 · routine";
    case 3:
      return "tier 3 · logic";
    case 4:
      return "tier 4 · critical";
    default:
      return "unscored";
  }
}

/** `lines 42–68`, or `line 42` for a one-line hunk. */
function leadRange(lead: WalkthroughLead): string {
  const end = hunkNewEnd(lead);
  return end === lead.newStart ? `line ${lead.newStart}` : `lines ${lead.newStart}–${end}`;
}

/** Most confirmed leads raised as `info` that sit outside the risk tier's issue budget. */
const LEAD_INFO_ALLOWANCE = 3;

/**
 * The first pass, framed so the agent verifies rather than transcribes. The
 * scan saw each hunk alone and can't see callers, so a lead that holds up in
 * the file is worth raising, and one that doesn't is noise to drop. The bug
 * bar's "not cosmetic" clause and the tier budget would otherwise drop every
 * readability lead before it was weighed, so a confirmed lead is exempt from
 * the one and gets a small allowance outside the other. Every lead owes a
 * `resolve_lead` verdict, which is what tells the reader the lead was read.
 */
function renderHunkLeadRules(count: number): string[] {
  return [
    "### First-pass leads",
    "",
    `Before you started, a fast pass judged each hunk of this diff in isolation, without the rest of the file or its callers. It flagged ${count} hunk${count === 1 ? "" : "s"}, listed under each file's header below as "First-pass leads", each with an id (\`L1\`, \`L2\`, …). They are leads, not findings: when you reach a file, check each of its leads against the code, and raise an issue only where the lead holds up once you can see the context. Never argue with a lead, and never mention the first pass, these leads, or their scores in the walkthrough itself.`,
    "",
    `A confirmed lead still has to clear the bug bar, with one exception: clause 1's "not cosmetic" does not apply to it. Readability is the impact of a long comment, an unclean hunk, or a hard-to-read one. Raise a confirmed readability lead as \`info\`. Up to ${LEAD_INFO_ALLOWANCE} confirmed leads raised as \`info\` sit outside the risk tier's issue budget; a lead you raise as \`warning\` or \`critical\` takes a slot like any other concern.`,
    "",
    "A long-comment lead holds up when you can name the sentences that go without losing a reason the code cannot express; the inline comment names them. A redundant-test lead holds up only when you can name what already protects that behaviour — another test you can point to, or the fact that nothing the code does could make the assertion fail; the issue then proposes deleting the test, not rewriting it.",
    "",
    "Give every lead a verdict with `resolve_lead` as soon as you have judged it: `confirmed` with the `issue_id` of the issue you raised for it (one issue may confirm several leads), or `rejected` with a one-sentence `reason` naming what in the code answers it. Independent verdicts can go out as parallel calls. `complete_walkthrough` refuses while any lead is unresolved.",
  ];
}

/** One file's leads, in line order, for the block under its diff header. */
function renderFileLeads(leads: ReadonlyArray<WalkthroughLead>, withPath: boolean): string[] {
  return [
    "First-pass leads:",
    ...[...leads]
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.newStart - b.newStart)
      .map(
        (lead) =>
          `- \`${lead.id}\` ${withPath ? `\`${lead.filePath}\` ` : ""}${leadRange(lead)} — ${lead.smells
            .map(
              (s) =>
                `${HUNK_SMELL_META[s.smell].label.toLowerCase()} (${s.probability.toFixed(2)})`,
            )
            .join(", ")}`,
      ),
  ];
}

/**
 * What the orchestrator worked out before the agent started, each one a given
 * the prompt states rather than a question it asks. Every field is optional:
 * absent means TypeSafe was off or had nothing to say.
 */
export interface WalkthroughPromptHints {
  /**
   * Risk tier the orchestrator already assigned. Present flips the tier
   * instruction to "this is your budget"; absent keeps "explore first,
   * then declare" (TypeSafe off).
   */
  assignedRisk?: RiskLevel;
  /**
   * Reading order for changed files, highest attention first, scored by
   * the orchestrator. Flips triage from agent-guessed to pre-triaged.
   * A null tier is past the scoring cap; sorts to the bottom, no claim.
   */
  filePriorities?: ReadonlyArray<{ readonly filename: string; readonly tier: number | null }>;
  /**
   * Present when the PR reads as several changes; tells the agent the
   * split call is already made and how many pieces to name.
   */
  splitRecommendation?: { readonly pieces: number };
  /**
   * Hunks the orchestrator's first pass flagged, strongest first. Leads to
   * verify, never findings — see {@link renderHunkLeadRules}.
   */
  hunkLeads?: ReadonlyArray<WalkthroughLead>;
  stack?: WalkthroughStackSnapshot;
}

function renderStackBlock(stack: WalkthroughStackSnapshot): string[] {
  const layers = [...stack.layers].sort((a, b) => a.position - b.position);
  return [
    "### Stack",
    `This pull request is layer ${stack.position} of ${layers.length} in stack #${stack.number}, onto \`${stack.baseRefName}\`.`,
    "",
    ...layers.map(
      (l) =>
        `- Layer ${l.position}: #${l.number} "${l.title}" — ${l.status.replace("_", " ")}${
          l.position === stack.position ? " ← this PR" : ""
        }`,
    ),
    "",
    "- The diff below is this layer's own changes only: GitHub scopes it to the layer below.",
    "- Before you flag something as missing, call `get_stack_context`. A higher layer may add it, and an absence a higher layer fills is not an issue.",
    "- Code in lower layers is out of scope unless this layer depends on it. When it does, say so in a comment on this layer's code, not in an issue against the lower layer.",
    "- Cite another layer as `#N (layer k)`.",
    "- Place this layer in the stack in one sentence of the overview's Context part.",
    "- A split recommendation, if there is one, concerns this layer alone.",
  ];
}

const INCREMENTAL_DIFF_SOURCE: Record<
  PromptDiffSource,
  { readonly input: string; readonly heading: string }
> = {
  full_pr: {
    input: "full PR diff",
    heading: "### Changed Files in Incremental Range (diff — prior reviewed head to current head)",
  },
  incremental_range: {
    input: "incremental range only",
    heading: "### Changed Files in Incremental Range (diff — prior reviewed head to current head)",
  },
  full_pr_fallback: {
    input: "full PR diff fallback because the incremental range could not be resolved locally",
    heading: "### Changed Files (full PR diff fallback — incremental range unavailable)",
  },
  stack_layer_delta: {
    input:
      "this layer's current changes in the files that changed since the prior review (stacked PR: lower-layer churn excluded)",
    heading:
      "### Changed Files Since the Prior Review (diff — this layer's current changes, per file)",
  },
};

export function buildWalkthroughPrompt(
  params: WalkthroughPromptHints & {
    pr: {
      title: string;
      body: string | null;
      sourceBranch: string;
      targetBranch: string;
      url: string;
    };
    mode?: WalkthroughMode;
    files: PrFileMeta[];
    reviewMode?: {
      readonly mode: "full" | "incremental";
      readonly parentWalkthroughId: string | null;
      readonly baseHeadSha: string | null;
      readonly headSha: string;
      readonly diffSource?: PromptDiffSource;
    };
  },
  maxTokenBudget = 40000,
  continuation?: PromptContinuationContext,
): string {
  const mode = params.mode ?? REVIEW_MODE.reviewer;
  const lines: string[] = [
    WALKTHROUGH_COMMON_PROMPT.trim(),
    "",
    mode === REVIEW_MODE.author
      ? WALKTHROUGH_AUTHOR_PROMPT.trim()
      : WALKTHROUGH_REVIEWER_PROMPT.trim(),
    "",
    `## Pull Request: ${params.pr.title}`,
    `Branch: ${params.pr.sourceBranch} → ${params.pr.targetBranch}`,
  ];
  if (params.pr.body) {
    lines.push("", "### Description", params.pr.body);
  }
  if (params.stack) {
    lines.push("", ...renderStackBlock(params.stack));
  }
  lines.push("", WALKTHROUGH_SHARED_REVIEW_PRINCIPLES);

  if (params.reviewMode?.mode === "incremental") {
    lines.push(
      "",
      WALKTHROUGH_INCREMENTAL_REFRESH_PROMPT,
      "",
      "### Incremental Range",
      `Previous reviewed head: ${params.reviewMode.baseHeadSha ?? "unknown"}`,
      `Current head: ${params.reviewMode.headSha}`,
      `Prior walkthrough id: ${params.reviewMode.parentWalkthroughId ?? "unknown"}`,
      `Diff input: ${INCREMENTAL_DIFF_SOURCE[params.reviewMode.diffSource ?? "full_pr"].input}`,
    );
  }

  // Commit history is intentionally NOT inlined here. The orchestrator
  // persists it on the walkthrough row at job start; the agent fetches it
  // lazily via the `get_commit_history` MCP read tool when it's about to
  // open the required "How we got here" journey chapter (chapter 0). This
  // keeps the prompt token-bounded on long PRs (up to 300 commits) and
  // resume reruns of the prompt cheap.

  const changedFilesHeading =
    params.reviewMode?.mode === "incremental"
      ? INCREMENTAL_DIFF_SOURCE[params.reviewMode.diffSource ?? "full_pr"].heading
      : "### Changed Files (diff — you can read full file contents with your tools)";

  // Leads ride under their file's header, so the agent meets each one while
  // it is reading that file rather than in a list it saw before the diff.
  const hunkLeads = params.hunkLeads ?? [];
  const leadsByPath = Map.groupBy(hunkLeads, (lead) => lead.filePath);
  if (hunkLeads.length > 0) {
    lines.push("", ...renderHunkLeadRules(hunkLeads.length));
  }

  lines.push("", changedFilesHeading, "");

  if (params.files.length === 0) {
    lines.push(
      params.reviewMode?.mode === "incremental"
        ? "No files changed in the incremental range. Use the prior review state to confirm whether the current PR assessment still stands, then produce a concise updated report."
        : "No changed files were returned for this PR.",
      "",
    );
  }

  // Files stay in diff order (reordering patches would scramble the
  // reader's mental model), but each header carries its scored tier.
  const tierByPath = new Map<string, number | null>(
    (params.filePriorities ?? []).map((f) => [f.filename, f.tier]),
  );
  const hasRankedFiles = (params.filePriorities?.length ?? 0) > 0;
  if (params.filePriorities && hasRankedFiles) {
    lines.push(
      "This list is already triaged. Each file below carries an attention tier, and these are the files in the order they deserve your attention:",
      "",
      ...params.filePriorities.map((f) => `- ${tierLabel(f.tier)} — \`${f.filename}\``),
      "",
      "Tier 0 files are generated or vendored: name the category and the count in one line, never a chapter. Spend your chapters on tier 3 and 4. The tier is a given, the same way the risk tier is — you may still find a tier-4 file uninteresting once you read it, but do not start by re-ranking the list.",
      "",
    );
  }

  let approxTokens = 0;
  for (const file of params.files) {
    const tier = tierByPath.get(file.filename);
    const tierSuffix = tier === undefined || tier === null ? "" : `, ${tierLabel(tier)}`;
    const fileLeads = leadsByPath.get(file.filename);
    leadsByPath.delete(file.filename);
    const header = [
      `#### ${file.filename} (${file.status}, +${file.additions} -${file.deletions}${tierSuffix})`,
      ...(fileLeads ? renderFileLeads(fileLeads, false) : []),
    ].join("\n");
    if (file.patch) {
      const patchTokens = file.patch.length / 4;
      if (approxTokens + patchTokens > maxTokenBudget) {
        lines.push(header, "[PATCH OMITTED — context limit reached]", "");
        continue;
      }
      lines.push(header, "```diff", file.patch, "```", "");
      approxTokens += patchTokens;
    } else if (file.status === REVERTED_FILE_STATUS) {
      lines.push(header, "[Change reverted — this layer no longer touches this file]", "");
    } else {
      lines.push(header, "[No patch available — binary or too large]", "");
    }
  }

  // Leads are recorded at the first start and a resume prompts with the same
  // set, so if the file list changed in between (an incremental range that
  // only resolves on the retry), a lead can name a file missing above. It
  // still owes a verdict, so it still reaches the agent.
  const strayLeads = [...leadsByPath.values()].flat();
  if (strayLeads.length > 0) {
    lines.push("#### Other files", ...renderFileLeads(strayLeads, true), "");
  }

  const firstActions = [
    "Call `get_walkthrough_state` before any other tool. The response will tell you whether this is a fresh run or a resume, and exactly which phase + steps are persisted. Use it to decide where to pick up. Never assume you are starting from scratch.",
    ...(params.stack
      ? [
          "Call `get_stack_context` once during Phase A. It returns what the other layers of this stack do: the takeaways and open issues of the layers below, the descriptions and changed files of the layers above. Read it before you plan the chapters, and again before flagging anything as missing.",
        ]
      : []),
    mode === REVIEW_MODE.author
      ? "Call `get_repo_context` once during Phase A. It returns recent daily/weekly project recaps for this repository. Use it only for risk patterns that are directly relevant to the current diff."
      : "Call `get_repo_context` once during Phase A. It returns recent daily/weekly project recaps for this repository, which let you ground your overview in what shipped recently, recurring themes, and risk patterns. Empty list = no prior context, proceed without. Do not cite recap themes unless directly relevant to this PR — no padding.",
    params.assignedRisk
      ? `The risk tier for this PR is already set to \`${params.assignedRisk}\` — it is a given, not yours to decide. Do NOT pass \`risk_level\` to \`set_overview\`; a value sent there is ignored. Work to that tier's chapter count and issue budget (see "Risk tiers" in the system prompt).${
          hasRankedFiles
            ? " The changed-files list is already triaged — work down it in the order given."
            : " Still triage the changed-files list into substantive and mechanical: generated output — lockfiles, snapshots, `.d.ts`, migration meta, vendored bundles, formatter-only reflows — gets one line naming the category and count, never a chapter."
        }`
      : hasRankedFiles
        ? 'The changed-files list above is already triaged — work down it in the order given. Size the risk tier on the tier-2-and-above pile only (see "Planning the chapters" in the system prompt).'
        : 'Triage the changed-files list above into substantive and mechanical before you declare the risk tier (see "Planning the chapters" in the system prompt). Generated output — lockfiles, snapshots, `.d.ts`, migration meta, vendored bundles, formatter-only reflows — gets one line naming the category and count, never a chapter. Size the tier on the substantive pile only.',
  ];
  lines.push("", "## First actions", "", ...firstActions.map((a, i) => `${i + 1}. ${a}`));

  if (params.splitRecommendation) {
    lines.push(
      "",
      `${firstActions.length + 1}. This pull request has been judged to carry ${params.splitRecommendation.pieces} independent concerns, and it earns a split recommendation. That call is made — your job is to NAME the seams, concretely and in the author's terms ("three PRs: the migration, the rate limiter, the unrelated lint fix"), never "consider breaking this up". Put the named split in the overview's takeaway line, raise it as a \`warning\` on the \`scope\` axis, and lead the Phase C verdict with it. Then review the pull request in front of you anyway, at the depth its risk deserves — the recommendation is for the author, the review is for whoever has to merge it today.`,
    );
  }

  if (continuation) {
    lines.push(
      "",
      "(Informational only — authoritative state lives in get_walkthrough_state. Provider hint: continuation context was provided; if your state query shows a resume scenario, follow the resume discipline in the system prompt.)",
    );
  }

  return lines.join("\n");
}
