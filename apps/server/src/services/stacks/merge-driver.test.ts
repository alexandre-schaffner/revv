import { describe, expect, test } from "bun:test";
import type { StackMergeMode, StackMergeRun } from "@revv/shared";
import { Effect } from "effect";
import { GitHubApiError, type GitHubError, GitHubNetworkError } from "../../domain/errors";
import type { GitHubStack, GitHubStackLayer } from "./map";
import {
  driveRun,
  MAX_READ_FAILURES,
  type MergeDriverPort,
  type SaveEffects,
} from "./merge-driver";
import { RETARGET_WAIT_MS } from "./merge-plan";

// ── A scripted GitHub ───────────────────────────────────────────────────────

function layer(position: number, over: Partial<GitHubStackLayer> = {}): GitHubStackLayer {
  return {
    nodeId: `N${position}`,
    position,
    number: 100 + position,
    title: `Layer ${position}`,
    url: "",
    headRef: `feat-${position}`,
    status: "ready",
    headSha: `h${position}`,
    baseRef: position === 1 ? "main" : `feat-${position - 1}`,
    mergeStateStatus: position === 1 ? "CLEAN" : "BLOCKED",
    reviewDecision: "approved",
    viewerReview: null,
    checks: "success",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    authorLogin: "a",
    mergedAt: null,
    autoMergeEnabled: false,
    isInMergeQueue: false,
    behindBy: null,
    ...over,
  };
}

interface WorldOptions {
  /** GitHub points the next layer at main itself, after this many reads. */
  readonly retargetAfterReads?: number | null;
  /** What a retargeted layer's merge state settles to (after one UNKNOWN read). */
  readonly settlesTo?: (number: number) => string;
  readonly mergeError?: (number: number) => GitHubError | null;
  readonly readError?: (read: number) => GitHubError | null;
  /** GitHub's auto-merge lands a handed-over layer after this many reads. */
  readonly autoMergeAfterReads?: number;
  /** What a layer's merge state is once its rebased head shows up. */
  readonly afterRebase?: (number: number) => string;
  /** Why the stack rebase fails, when it does. */
  readonly rebaseFails?: () => string | null;
  /** Cancel the run (the row leaves `running`) before this many saves. */
  readonly cancelAtSave?: number;
}

function world(layers: GitHubStackLayer[], opts: WorldOptions = {}) {
  let now = 0;
  let reads = 0;
  let cancelled = false;
  const state = layers.map((l) => ({ ...l }));
  const pending: {
    number: number;
    dueAt: number;
    kind: "retarget" | "settle" | "auto" | "rebased";
  }[] = [];
  const writes: string[] = [];
  const saves: { run: StackMergeRun; effects: SaveEffects }[] = [];

  const set = (number: number, patch: Partial<GitHubStackLayer>) => {
    const i = state.findIndex((l) => l.number === number);
    const current = state[i];
    if (current) state[i] = { ...current, ...patch };
  };

  const settle = (number: number) => {
    set(number, { mergeStateStatus: "UNKNOWN" });
    pending.push({ number, dueAt: reads + 1, kind: "settle" });
  };

  const stack = (): GitHubStack => ({
    number: 7,
    baseRefName: "main",
    layers: state.map((l) => ({ ...l })),
    autoMergeAllowed: true,
    allowedMethods: ["merge"],
    viewerCanPush: true,
    fetchedAt: "",
  });

  const port: MergeDriverPort = {
    read: () =>
      Effect.suspend(() => {
        reads += 1;
        const err = opts.readError?.(reads);
        if (err) return Effect.fail(err);
        for (const p of pending.filter((x) => x.dueAt <= reads)) {
          pending.splice(pending.indexOf(p), 1);
          if (p.kind === "retarget") {
            set(p.number, { baseRef: "main" });
            settle(p.number);
          } else if (p.kind === "rebased") {
            const l = state.find((x) => x.number === p.number);
            set(p.number, {
              headSha: `${l?.headSha}r`,
              mergeStateStatus: opts.afterRebase?.(p.number) ?? "CLEAN",
              behindBy: 0,
            });
          } else if (p.kind === "settle") {
            set(p.number, { mergeStateStatus: opts.settlesTo?.(p.number) ?? "CLEAN" });
          } else {
            mergeLayer(p.number);
          }
        }
        return Effect.succeed({ stack: stack(), mergedOutside: new Set<number>() });
      }),
    merge: (number, method, sha) =>
      Effect.suspend(() => {
        writes.push(`merge #${number} ${method} @${sha}`);
        const err = opts.mergeError?.(number);
        if (err) return Effect.fail(err);
        mergeLayer(number);
        return Effect.void;
      }),
    retarget: (number, base) =>
      Effect.sync(() => {
        writes.push(`retarget #${number} -> ${base}`);
        set(number, { baseRef: base });
        settle(number);
      }),
    rebase: (current) =>
      Effect.suspend(() => {
        writes.push("rebase stack");
        const failure = opts.rebaseFails?.();
        if (failure) return Effect.fail(failure);
        const moved = current.layers.flatMap((l) =>
          l.status === "merged" || !l.headSha
            ? []
            : [{ number: l.number, from: l.headSha, to: `${l.headSha}r` }],
        );
        // GitHub reports the old heads for a read, then the rebased ones.
        for (const m of moved) {
          pending.push({ number: m.number, dueAt: reads + 2, kind: "rebased" });
        }
        return Effect.succeed(moved);
      }),
    enableAutoMerge: (nodeId, method, sha) =>
      Effect.sync(() => {
        writes.push(`auto-merge ${nodeId} ${method} @${sha}`);
        const l = state.find((x) => x.nodeId === nodeId);
        if (!l) return;
        set(l.number, { autoMergeEnabled: true });
        pending.push({
          number: l.number,
          dueAt: reads + (opts.autoMergeAfterReads ?? 2),
          kind: "auto",
        });
      }),
    save: (run, effects) =>
      Effect.sync(() => {
        if (opts.cancelAtSave !== undefined && saves.length + 1 >= opts.cancelAtSave) {
          cancelled = true;
        }
        if (cancelled) return false;
        saves.push({ run, effects });
        return true;
      }),
    isActive: () => Effect.succeed(!cancelled),
    now: () => now,
    sleep: (ms) =>
      Effect.sync(() => {
        now += ms;
      }),
  };

  function mergeLayer(number: number) {
    const merged = state.find((l) => l.number === number);
    set(number, { status: "merged", mergedAt: "now", autoMergeEnabled: false });
    if (!merged || opts.retargetAfterReads === null) return;
    for (const l of state) {
      if (l.baseRef === merged.headRef) {
        pending.push({
          number: l.number,
          dueAt: reads + (opts.retargetAfterReads ?? 1),
          kind: "retarget",
        });
      }
    }
  }

  return { port, writes, saves, elapsed: () => now };
}

function runOf(count: number, mode: StackMergeMode = "driven"): StackMergeRun {
  return {
    id: "run-1",
    repositoryId: "repo",
    stackNumber: 7,
    throughPosition: count,
    method: "merge",
    mode,
    status: "running",
    layers: Array.from({ length: count }, (_, i) => ({
      position: i + 1,
      number: 101 + i,
      expectedHeadSha: `h${i + 1}`,
      state: "pending" as const,
      message: null,
    })),
    error: null,
    createdAt: "",
    updatedAt: "",
  };
}

const drive = (run: StackMergeRun, port: MergeDriverPort) => Effect.runPromise(driveRun(run, port));

// ── Scenarios ───────────────────────────────────────────────────────────────

describe("driveRun", () => {
  test("merges bottom-up, each pinned, as GitHub retargets the next layer", async () => {
    const gh = world([layer(1), layer(2), layer(3)]);
    const run = await drive(runOf(3), gh.port);
    expect(run.status).toBe("complete");
    expect(gh.writes).toEqual([
      "merge #101 merge @h1",
      "merge #102 merge @h2",
      "merge #103 merge @h3",
    ]);
    expect(run.layers.map((l) => l.state)).toEqual(["merged", "merged", "merged"]);
    // Every merge is announced as moving the stack, for the local PR rows.
    expect(gh.saves.flatMap((s) => s.effects.merged)).toEqual([101, 102, 103]);
    expect(gh.saves.at(-1)?.run.status).toBe("complete");
  });

  test("stops on a 409: the head moved after the user confirmed", async () => {
    const gh = world([layer(1), layer(2)], {
      mergeError: (n) => (n === 102 ? new GitHubApiError({ status: 409, cause: "moved" }) : null),
    });
    const run = await drive(runOf(2), gh.port);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("#102 got new commits after you confirmed — review them first");
    expect(run.layers.map((l) => l.state)).toEqual(["merged", "failed"]);
  });

  test("rebases the stack when the next layer settles BEHIND, then merges the rebased head", async () => {
    const gh = world([layer(1), layer(2), layer(3)], {
      settlesTo: (n) => (n === 102 ? "BEHIND" : "CLEAN"),
    });
    const run = await drive(runOf(3), gh.port);
    expect(run.status).toBe("complete");
    expect(gh.writes).toEqual([
      "merge #101 merge @h1",
      "rebase stack",
      "merge #102 merge @h2r",
      "merge #103 merge @h3r",
    ]);
    expect(run.layers[1]).toMatchObject({ expectedHeadSha: "h2r", rebasedFrom: "h2" });
    // The step that rebased was announced as moving the stack.
    expect(gh.saves.some((s) => s.run.layers[1]?.state === "rebasing")).toBe(true);
  });

  test("rebases a layer only once per run", async () => {
    const gh = world([layer(1), layer(2)], {
      settlesTo: () => "BEHIND",
      afterRebase: () => "BEHIND",
    });
    const run = await drive(runOf(2), gh.port);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("#102 needs a rebase onto main");
    expect(gh.writes.filter((w) => w === "rebase stack")).toHaveLength(1);
  });

  test("stops with the rebase's own reason when it can't rebase", async () => {
    const gh = world([layer(1), layer(2)], {
      settlesTo: (n) => (n === 102 ? "DIRTY" : "CLEAN"),
      rebaseFails: () => "#102 conflicts with main in a.ts — resolve it locally (gh stack rebase)",
    });
    const run = await drive(runOf(2), gh.port);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(
      "#102 conflicts with main in a.ts — resolve it locally (gh stack rebase)",
    );
    expect(run.layers.map((l) => l.state)).toEqual(["merged", "failed"]);
  });

  test("retargets a layer GitHub left on the merged branch, after the wait budget", async () => {
    const gh = world([layer(1), layer(2)], { retargetAfterReads: null });
    const run = await drive(runOf(2), gh.port);
    expect(run.status).toBe("complete");
    expect(gh.writes).toEqual([
      "merge #101 merge @h1",
      "retarget #102 -> main",
      "merge #102 merge @h2",
    ]);
    expect(gh.elapsed()).toBeGreaterThanOrEqual(RETARGET_WAIT_MS);
    expect(gh.saves.some((s) => s.run.layers[1]?.state === "retargeting")).toBe(true);
  });

  test("auto mode hands a layer waiting on checks to GitHub, then carries on", async () => {
    const gh = world([layer(1, { mergeStateStatus: "BLOCKED", checks: "pending" }), layer(2)], {
      autoMergeAfterReads: 3,
    });
    const run = await drive(runOf(2, "auto"), gh.port);
    expect(run.status).toBe("complete");
    expect(gh.writes).toEqual(["auto-merge N1 merge @h1", "merge #102 merge @h2"]);
    expect(gh.saves.some((s) => s.run.layers[0]?.state === "auto_merge")).toBe(true);
    expect(gh.saves.some((s) => s.run.status === "waiting")).toBe(true);
  });

  test("driven mode waits out running checks instead", async () => {
    const gh = world([layer(1, { mergeStateStatus: "BLOCKED", checks: "pending" })]);
    const run = await drive(runOf(1), gh.port);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("#101's checks didn't finish in time");
    expect(gh.writes).toEqual([]);
  });

  test("a cancel between steps stops the run before its next GitHub write", async () => {
    const gh = world([layer(1), layer(2)], { cancelAtSave: 3 });
    await drive(runOf(2), gh.port);
    expect(gh.writes).toEqual(["merge #101 merge @h1"]);
  });

  test("rides out a GitHub blip, gives up after a run of them", async () => {
    const blip = world([layer(1)], {
      readError: (n) => (n <= 2 ? new GitHubNetworkError({ cause: "reset" }) : null),
    });
    expect((await drive(runOf(1), blip.port)).status).toBe("complete");

    const down = world([layer(1)], {
      readError: () => new GitHubNetworkError({ cause: "reset" }),
    });
    const run = await drive(runOf(1), down.port);
    expect(run.status).toBe("failed");
    expect(down.writes).toEqual([]);
    expect(run.error).toContain("Continue");
    expect(MAX_READ_FAILURES).toBeGreaterThan(2);
  });
});
