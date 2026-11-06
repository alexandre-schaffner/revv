// ── Workspace claims ───────────────────────────────────────────────────────
//
// One thing at a time works in a PR's agent worktree: a chat turn, a push, or
// an edit of the agent's commits. A claim that isn't touched for `idleMs`
// expires, so a holder that never releases (a stream whose cleanup never ran,
// an upstream read that never settles) costs one idle window instead of
// blocking the PR until the server restarts. Holders touch the claim as they
// make progress.
//
// In-memory on purpose: a claim cannot outlive the process holding it, and a
// restart drops the work it guarded.

import type { WorkspaceHolder } from "../../domain/errors";
import { logError } from "../../logger";

export interface WorkspaceClaim {
  readonly holder: WorkspaceHolder;
  /** Re-arm the idle expiry. */
  readonly touch: () => void;
  /** Give the workspace back. Idempotent, and never drops a later holder's claim. */
  readonly release: () => void;
}

export interface WorkspaceClaims {
  /** Claim `prId`, or answer who already holds it. */
  readonly take: (prId: string, holder: WorkspaceHolder) => WorkspaceClaim | WorkspaceHolder;
  readonly holder: (prId: string) => WorkspaceHolder | null;
}

export function createWorkspaceClaims(
  idleMs: number,
  now: () => number = Date.now,
): WorkspaceClaims {
  const held = new Map<string, { holder: WorkspaceHolder; touchedAt: number; token: symbol }>();

  const live = (prId: string) => {
    const entry = held.get(prId);
    if (!entry) return null;
    const silentFor = now() - entry.touchedAt;
    if (silentFor < idleMs) return entry;
    held.delete(prId);
    logError(
      "pr-workspace",
      `dropping the ${entry.holder} claim on pr=${prId}: ${Math.round(silentFor / 1000)}s ` +
        "without progress, and its holder never released it",
    );
    return null;
  };

  return {
    take: (prId, holder) => {
      const current = live(prId);
      if (current) return current.holder;
      const token = Symbol(prId);
      held.set(prId, { holder, touchedAt: now(), token });
      const mine = () => held.get(prId)?.token === token;
      return {
        holder,
        touch: () => {
          const entry = held.get(prId);
          if (entry?.token === token) entry.touchedAt = now();
        },
        release: () => {
          if (mine()) held.delete(prId);
        },
      };
    },
    holder: (prId) => live(prId)?.holder ?? null,
  };
}
