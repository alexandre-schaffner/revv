import type { WalkthroughGenerationMode, WalkthroughStackSnapshot } from "@revv/shared";
import { Effect } from "effect";
import { logError } from "../logger";
import {
  commitExists,
  diffNameStatusZ,
  diffNumstat,
  diffPatchForPath,
  fetchCommit,
  redactGitAuth,
} from "./GitOps";
import {
  capPatch,
  normalizeGitStatus,
  parseNameStatusZ,
  parseNumstat,
  resolveCounts,
} from "./incremental-diff";
import { changedFiles, type DiffFingerprint, fingerprintFiles } from "./stacks/fingerprint";

export interface PromptFile {
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

interface PromptFilesContext {
  readonly pr: { readonly id: string };
  readonly token: string;
  readonly prHeadSha: string;
  readonly repoFullName: string;
  readonly githubHost: string;
  readonly files: ReadonlyArray<PromptFile>;
  readonly generationMode: WalkthroughGenerationMode;
  readonly baseHeadSha: string | null;
  readonly stack?: WalkthroughStackSnapshot | null;
  readonly parentFingerprint?: DiffFingerprint | null;
}

export type PromptDiffSource =
  | "full_pr"
  | "incremental_range"
  | "full_pr_fallback"
  | "stack_layer_delta";

export interface PromptFilesResult {
  readonly files: ReadonlyArray<PromptFile>;
  readonly diffSource: PromptDiffSource;
}

export const REVERTED_FILE_STATUS = "reverted";

export function stackLayerDeltaFiles(
  files: ReadonlyArray<PromptFile>,
  parentFingerprint: DiffFingerprint,
): PromptFile[] {
  const changed = new Set(changedFiles(parentFingerprint, fingerprintFiles(files)));
  const current = new Set(files.map((f) => f.filename));
  const reverted = [...changed]
    .filter((filename) => !current.has(filename))
    .map(
      (filename): PromptFile => ({
        filename,
        previousFilename: null,
        status: REVERTED_FILE_STATUS,
        additions: 0,
        deletions: 0,
        patch: null,
      }),
    );
  return [...files.filter((f) => changed.has(f.filename)), ...reverted];
}

function authedRepoUrl(ctx: PromptFilesContext): string {
  return `https://x-access-token:${ctx.token}@${ctx.githubHost}/${ctx.repoFullName}.git`;
}

export function resolveIncrementalPromptFiles(
  ctx: PromptFilesContext,
  worktreePath: string,
): Effect.Effect<PromptFilesResult> {
  if (ctx.generationMode !== "incremental" || !ctx.baseHeadSha) {
    return Effect.succeed({ files: ctx.files, diffSource: "full_pr" });
  }
  if (ctx.stack && ctx.parentFingerprint) {
    return Effect.succeed({
      files: stackLayerDeltaFiles(ctx.files, ctx.parentFingerprint),
      diffSource: "stack_layer_delta",
    });
  }
  const baseHeadSha = ctx.baseHeadSha;

  return Effect.tryPromise({
    try: async () => {
      if (!(await commitExists(worktreePath, baseHeadSha))) {
        await fetchCommit(worktreePath, authedRepoUrl(ctx), baseHeadSha);
      }
      if (!(await commitExists(worktreePath, baseHeadSha))) {
        throw new Error(`base commit ${baseHeadSha} is not available locally`);
      }

      const nameStatus = parseNameStatusZ(
        await diffNameStatusZ(worktreePath, baseHeadSha, ctx.prHeadSha),
      );
      // `--numstat` in one call, not scanning each patch body: that would force a
      // synchronous multi-MB split on the event loop for large/generated files.
      const numstat = parseNumstat(await diffNumstat(worktreePath, baseHeadSha, ctx.prHeadSha));
      const files: PromptFile[] = [];
      for (const file of nameStatus) {
        let patch: string | null = null;
        try {
          const rawPatch = await diffPatchForPath(
            worktreePath,
            baseHeadSha,
            ctx.prHeadSha,
            file.filename,
          );
          patch = capPatch(rawPatch);
        } catch {
          patch = null;
        }
        const counts = resolveCounts(numstat, file.filename, patch);
        files.push({
          filename: file.filename,
          previousFilename: file.previousFilename,
          status: normalizeGitStatus(file.status),
          additions: counts.additions,
          deletions: counts.deletions,
          patch,
        });
      }
      return { files, diffSource: "incremental_range" as const };
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      logError(
        "walkthrough-jobs",
        `incremental diff build failed pr=${ctx.pr.id} base=${ctx.baseHeadSha} head=${ctx.prHeadSha}; falling back to full PR diff: ${redactGitAuth(
          cause instanceof Error ? cause.message : String(cause),
        )}`,
      );
      return Effect.succeed({ files: ctx.files, diffSource: "full_pr_fallback" as const });
    }),
  );
}
