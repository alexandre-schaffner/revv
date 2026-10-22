import type { GitHubCall } from "./record";

export type FindingKind =
  | "duplicate-inflight"
  | "duplicate-repeat"
  | "waterfall"
  | "serial-pagination"
  | "fan-out"
  | "slow-op"
  | "failing-op"
  | "heavy-op"
  | "contention"
  | "unattributed";

export interface Finding {
  readonly kind: FindingKind;
  readonly cost: number;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly fix: string;
}

export interface OriginRow {
  readonly label: string;
  readonly kind: string;
  readonly runs: number;
  readonly calls: number;
  readonly p50RunMs: number;
  readonly p95RunMs: number;
  readonly maxRunMs: number;
}

export interface OpRow {
  readonly op: string;
  readonly calls: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly notModified: number;
  readonly avgBytes: number;
  readonly errors: number;
  readonly points: number;
  readonly origins: readonly string[];
}

export interface RateRow {
  readonly account: string;
  readonly resource: string;
  /**
   * Points the window burned, from `x-ratelimit-used` deltas. The budget is
   * per token, so another client on it (the installed Revv, `gh`, an IDE)
   * lands here too: a REST call costs at most one point, so REST deltas past
   * that go to `outside`; GraphQL costs vary per query, so they can't be split.
   */
  readonly used: number;
  readonly outside: number;
  readonly remaining: number;
  readonly limit: number;
  readonly byOrigin: readonly { readonly label: string; readonly used: number }[];
}

export interface Report {
  readonly from: number | null;
  readonly to: number | null;
  readonly calls: number;
  readonly userFacingCalls: number;
  readonly findings: readonly Finding[];
  readonly origins: readonly OriginRow[];
  readonly ops: readonly OpRow[];
  readonly rate: readonly RateRow[];
}

export interface AnalyzeOptions {
  readonly repeatWindowMs?: number;
  readonly slowMs?: number;
}

const BACKGROUND_WEIGHT = 0.25;

const durationOf = (c: GitHubCall) => c.durationMs ?? c.ttfbMs ?? 0;
const endOf = (c: GitHubCall) => c.start + durationOf(c);
const isUserFacing = (c: GitHubCall) => c.origin.kind === "request";
const weight = (c: GitHubCall) => (isUserFacing(c) ? 1 : BACKGROUND_WEIGHT);
const ms = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}s` : `${Math.round(n)}ms`);

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function top<T>(items: Iterable<T>, n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(String(item), (counts.get(String(item)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => (v > 1 ? `${k} ×${v}` : k));
}

function wallOf(calls: readonly GitHubCall[]): number {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  let wall = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const c of sorted) {
    const start = Math.max(c.start, cursor);
    const end = endOf(c);
    if (end > start) wall += end - start;
    cursor = Math.max(cursor, end);
  }
  return wall;
}

function duplicates(calls: readonly GitHubCall[], windowMs: number): Finding[] {
  const reads = calls.filter((c) => !c.write);
  const inflight = new Map<string, { wasted: GitHubCall[]; pairs: string[] }>();
  const repeats = new Map<string, { wasted: GitHubCall[]; pairs: string[]; gaps: number[] }>();
  for (const same of groupBy(reads, (c) => c.key).values()) {
    if (same.length < 2) continue;
    same.sort((a, b) => a.start - b.start);
    for (let i = 1; i < same.length; i++) {
      const prev = same[i - 1];
      const cur = same[i];
      if (!prev || !cur) continue;
      const gap = cur.start - endOf(prev);
      if (gap > windowMs) continue;
      const pair =
        prev.origin.label === cur.origin.label
          ? cur.origin.label
          : `${prev.origin.label} → ${cur.origin.label}`;
      if (gap < 0) {
        const entry = inflight.get(cur.op) ?? { wasted: [], pairs: [] };
        entry.wasted.push(cur);
        entry.pairs.push(pair);
        inflight.set(cur.op, entry);
      } else {
        const entry = repeats.get(cur.op) ?? { wasted: [], pairs: [], gaps: [] };
        entry.wasted.push(cur);
        entry.pairs.push(pair);
        entry.gaps.push(gap);
        repeats.set(cur.op, entry);
      }
    }
  }
  const findings: Finding[] = [];
  for (const [op, { wasted, pairs }] of inflight) {
    findings.push({
      kind: "duplicate-inflight",
      cost: wasted.reduce((sum, c) => sum + durationOf(c) * weight(c), 0) * 0.5,
      title: `${op}: ${wasted.length} identical request(s) sent while the first was still in flight`,
      evidence: [`callers: ${top(pairs, 4).join(", ")}`],
      fix: "Share the in-flight promise (coalesce by request key) instead of asking twice.",
    });
  }
  for (const [op, { wasted, pairs, gaps }] of repeats) {
    const notModified = wasted.filter((c) => c.status === 304).length;
    findings.push({
      kind: "duplicate-repeat",
      cost: wasted.reduce((sum, c) => sum + durationOf(c) * weight(c), 0),
      title: `${op}: ${wasted.length} repeat(s) of an identical read within ${ms(windowMs)}`,
      evidence: [
        `median gap after the previous answer: ${ms(percentile(gaps, 50))}`,
        `${notModified}/${wasted.length} came back 304; each still cost a round trip (p50 ${ms(percentile(wasted.map(durationOf), 50))})`,
        `callers: ${top(pairs, 4).join(", ")}`,
      ],
      fix: "Serve the last answer from memory for a short TTL, or hand it from the first caller to the second.",
    });
  }
  return findings;
}

interface Read {
  readonly op: string;
  readonly start: number;
  readonly end: number;
  readonly pages: number;
  readonly calls: readonly GitHubCall[];
}

function readsOf(run: readonly GitHubCall[]): Read[] {
  return [...groupBy(run, (c) => c.read).values()]
    .map((pages) => ({
      op: pages[0]?.op ?? "?",
      start: Math.min(...pages.map((c) => c.start)),
      end: Math.max(...pages.map(endOf)),
      pages: pages.length,
      calls: pages,
    }))
    .sort((a, b) => a.start - b.start);
}

function perRun(calls: readonly GitHubCall[]): Finding[] {
  const runs = groupBy(
    calls.filter((c) => c.origin.runId !== "-"),
    (c) => c.origin.runId,
  );
  const waterfalls = new Map<string, { saved: number[]; worst: string; weight: number }>();
  const pagination = new Map<
    string,
    { pages: number[]; cost: number; graphql: boolean; weight: number }
  >();
  const fanOut = new Map<string, { counts: number[]; weight: number }>();

  for (const run of runs.values()) {
    const first = run[0];
    if (!first) continue;
    const label = first.origin.label;
    const w = weight(first);
    const t0 = Math.min(...run.map((c) => c.start));
    const reads = readsOf(run);

    let stages = 0;
    let frontier = Number.NEGATIVE_INFINITY;
    for (const r of reads) {
      if (r.start >= frontier) stages++;
      frontier = Math.max(frontier, r.end);
    }
    const wall = wallOf(run);
    const longest = Math.max(...reads.map((r) => r.end - r.start));
    if (stages >= 3 && wall - longest >= 250) {
      const entry = waterfalls.get(label) ?? { saved: [], worst: "", weight: w };
      if (wall - longest > Math.max(0, ...entry.saved)) {
        entry.worst = reads
          .slice(0, 12)
          .map(
            (r) =>
              `  +${ms(r.start - t0)} ${r.op} (${ms(r.end - r.start)}${r.pages > 1 ? `, ${r.pages} pages` : ""})`,
          )
          .join("\n");
      }
      entry.saved.push(wall - longest);
      waterfalls.set(label, entry);
    }

    for (const r of reads) {
      if (r.pages < 3) continue;
      const graphql = r.op.startsWith("graphql");
      const durations = r.calls.map(durationOf);
      // REST pages can be fetched together once page 1 names the last one;
      // GraphQL cursors can't, so what's on the table is every page past the first.
      const cost = graphql
        ? durations.slice(1).reduce((a, b) => a + b, 0)
        : Math.max(0, r.end - r.start - 2 * Math.max(...durations));
      const key = `${label}  ${r.op}`;
      const entry = pagination.get(key) ?? { pages: [], cost: 0, graphql, weight: w };
      entry.pages.push(r.pages);
      entry.cost += cost;
      pagination.set(key, entry);
    }

    for (const [op, same] of groupBy(reads, (r) => r.op)) {
      if (same.length < 5) continue;
      const key = `${label}  ${op}`;
      const entry = fanOut.get(key) ?? { counts: [], weight: w };
      entry.counts.push(same.length);
      fanOut.set(key, entry);
    }
  }

  const findings: Finding[] = [];
  for (const [label, { saved, worst, weight: w }] of waterfalls) {
    findings.push({
      kind: "waterfall",
      cost: saved.reduce((a, b) => a + b, 0) * w,
      title: `${label}: reads wait on each other (${saved.length} run(s), up to ${ms(Math.max(...saved))} on the table)`,
      evidence: [`worst run, read by read (pages collapsed):\n${worst}`],
      fix: "Start independent reads together (Effect.all with concurrency); only a read that needs another's answer should wait for it.",
    });
  }
  for (const [key, { pages, cost, graphql, weight: w }] of pagination) {
    const total = pages.reduce((a, b) => a + b, 0);
    findings.push({
      kind: "serial-pagination",
      cost: cost * w,
      title: `${key}: ${total} pages over ${pages.length} read(s), up to ${Math.max(...pages)} in one`,
      evidence: [`pages per read: ${top(pages, 6).join(", ")}`],
      fix: graphql
        ? "Cursor pages can't run in parallel: read less. Filter to what changed since the last read (e.g. updatedAt), stop at the first page already known, or ask for fewer fields per node."
        : "Read page 1, take the last page from its Link header, fetch the rest concurrently — or ask GraphQL for the slice actually shown.",
    });
  }
  for (const [key, { counts, weight: w }] of fanOut) {
    findings.push({
      kind: "fan-out",
      cost: counts.reduce((a, b) => a + b, 0) * 40 * w,
      title: `${key}: up to ${Math.max(...counts)} separate reads of one endpoint in a single run`,
      evidence: [`${counts.length} run(s); reads per run: ${top(counts, 4).join(", ")}`],
      fix: "Batch them (one GraphQL query with aliases, or the list endpoint), or cache the answers.",
    });
  }
  return findings;
}

function perOp(
  calls: readonly GitHubCall[],
  slowMs: number,
  points: ReadonlyMap<string, number>,
): { rows: OpRow[]; findings: Finding[] } {
  const rows: OpRow[] = [];
  const findings: Finding[] = [];
  for (const [op, same] of groupBy(calls, (c) => c.op)) {
    const durations = same.map(durationOf);
    const errors = same.filter((c) => c.error !== null);
    const sized = same.filter((c) => c.bytes !== null);
    const avgBytes = sized.length
      ? sized.reduce((s, c) => s + (c.bytes ?? 0), 0) / sized.length
      : 0;
    rows.push({
      op,
      calls: same.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      maxMs: Math.max(...durations),
      notModified: same.filter((c) => c.status === 304).length / same.length,
      avgBytes,
      errors: errors.length,
      points: points.get(op) ?? 0,
      origins: top(
        same.map((c) => c.origin.label),
        3,
      ),
    });

    const facing = same.filter(isUserFacing);
    const facingDurations = facing.map(durationOf);
    const p95 = percentile(facingDurations, 95);
    if (facing.length > 0 && p95 >= slowMs) {
      findings.push({
        kind: "slow-op",
        cost: facingDurations.reduce((s, d) => s + Math.max(0, d - slowMs / 2), 0),
        title: `${op}: p95 ${ms(p95)} on a user-facing path (${facing.length} call(s))`,
        evidence: [
          `p50 ${ms(percentile(facingDurations, 50))}, max ${ms(Math.max(...facingDurations))}, avg ${Math.round(avgBytes / 1024)}KB`,
          `waiting: ${top(
            facing.map((c) => c.origin.label),
            3,
          ).join(", ")}`,
          ...(same[0]?.site ? [`called from ${same[0].site}`] : []),
        ],
        fix: op.startsWith("graphql")
          ? "Split the slow fields off the critical query (fields GitHub computes on demand, like mergeStateStatus, cost seconds) and load them after first paint."
          : "Cache it, narrow it, or move it off the request path.",
      });
    }
    if (errors.length > 0) {
      findings.push({
        kind: "failing-op",
        cost: errors.reduce((s, c) => s + Math.max(durationOf(c), 500) * weight(c), 0),
        title: `${op}: ${errors.length}/${same.length} call(s) failed`,
        evidence: top(
          errors.map((c) => c.error ?? ""),
          3,
        ),
        fix: "A failure GitHub reports as transient earns a retry; a timeout means the query is too heavy.",
      });
    }
    if (avgBytes >= 256 * 1024) {
      findings.push({
        kind: "heavy-op",
        cost: same.reduce((s, c) => s + ((c.bytes ?? 0) / 1024) * weight(c), 0) * 0.2,
        title: `${op}: ${Math.round(avgBytes / 1024)}KB per answer on average`,
        evidence: [
          `${same.length} call(s), ${Math.round((avgBytes * same.length) / 1024 / 1024)}MB total`,
        ],
        fix: "Ask for fewer fields or a smaller page; every KB is transfer and JSON parse time.",
      });
    }
  }
  rows.sort((a, b) => b.calls * b.p50Ms - a.calls * a.p50Ms);
  return { rows, findings };
}

function contention(calls: readonly GitHubCall[]): Finding[] {
  const facing = calls.filter(isUserFacing);
  const crowded = facing.filter((c) => c.inflightBackground >= 3);
  if (crowded.length === 0) return [];
  const quiet = new Map<string, number[]>();
  for (const c of facing) {
    if (c.inflightBackground > 0) continue;
    const list = quiet.get(c.op) ?? [];
    list.push(c.ttfbMs ?? 0);
    quiet.set(c.op, list);
  }
  let extra = 0;
  for (const c of crowded) {
    const baseline = quiet.get(c.op);
    if (baseline?.length) extra += Math.max(0, (c.ttfbMs ?? 0) - percentile(baseline, 50));
  }
  return [
    {
      kind: "contention",
      cost: extra,
      title: `${crowded.length} user-facing call(s) started behind 3+ background calls`,
      evidence: [
        `worst queue: ${Math.max(...crowded.map((c) => c.inflightBackground))} background calls in flight`,
        `slower than the same op on a quiet line by ${ms(extra)} in total`,
        `background in the way: ${top(
          calls.filter((c) => c.origin.kind !== "request").map((c) => c.origin.label),
          3,
        ).join(", ")}`,
      ],
      fix: "Pause or throttle background sweeps while a page is loading; GitHub paces concurrent requests per token.",
    },
  ];
}

function unattributed(calls: readonly GitHubCall[]): Finding[] {
  const lost = calls.filter((c) => c.origin.kind === "none");
  if (lost.length === 0) return [];
  return [
    {
      kind: "unattributed",
      cost: lost.length,
      title: `${lost.length} call(s) carry no origin`,
      evidence: top(
        lost.map((c) => `${c.op} ← ${c.site ?? "?"}`),
        5,
      ),
      fix: "Route the call through githubTryPromise, or wrap its loop in withGitHubOrigin.",
    },
  ];
}

function originsOf(calls: readonly GitHubCall[]): OriginRow[] {
  const rows: OriginRow[] = [];
  for (const [label, same] of groupBy(calls, (c) => c.origin.label)) {
    const runs = [...groupBy(same, (c) => c.origin.runId).values()];
    const walls = runs.map((run) => {
      const start = Math.min(...run.map((c) => c.start));
      return Math.max(...run.map(endOf)) - start;
    });
    rows.push({
      label,
      kind: same[0]?.origin.kind ?? "none",
      runs: runs.length,
      calls: same.length,
      p50RunMs: percentile(walls, 50),
      p95RunMs: percentile(walls, 95),
      maxRunMs: Math.max(...walls),
    });
  }
  return rows.sort((a, b) => b.calls - a.calls);
}

function rateOf(calls: readonly GitHubCall[]): {
  rows: RateRow[];
  byOp: Map<string, number>;
} {
  const rows: RateRow[] = [];
  const byOp = new Map<string, number>();
  const rated = calls.filter((c) => c.rate !== null && Number.isFinite(c.rate.used));
  for (const same of groupBy(rated, (c) => `${c.account} ${c.rate?.resource}`).values()) {
    let used = 0;
    let outside = 0;
    const graphql = same[0]?.rate?.resource === "graphql";
    const byOrigin = new Map<string, number>();
    // One budget hour at a time. Answers to concurrent calls arrive out of
    // order, so within an hour `used` is read in its own order, not arrival's:
    // each call is charged what the counter moved since the one below it.
    for (const hour of groupBy(same, (c) => String(c.rate?.reset ?? "?")).values()) {
      hour.sort((a, b) => (a.rate?.used ?? 0) - (b.rate?.used ?? 0));
      let previous: number | null = null;
      for (const c of hour) {
        const now = c.rate?.used ?? 0;
        const raw = previous === null ? 0 : now - previous;
        previous = now;
        const delta = graphql ? raw : Math.min(raw, 1);
        outside += raw - delta;
        used += delta;
        byOrigin.set(c.origin.label, (byOrigin.get(c.origin.label) ?? 0) + delta);
        byOp.set(c.op, (byOp.get(c.op) ?? 0) + delta);
      }
    }
    const last = same.reduce((a, b) => (b.start > a.start ? b : a));
    rows.push({
      account: last.account ?? "?",
      resource: last.rate?.resource ?? "?",
      used,
      outside,
      remaining: last.rate?.remaining ?? 0,
      limit: last.rate?.limit ?? 0,
      byOrigin: [...byOrigin]
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, n]) => ({ label, used: n })),
    });
  }
  return { rows: rows.sort((a, b) => b.used - a.used), byOp };
}

export function analyze(calls: readonly GitHubCall[], options: AnalyzeOptions = {}): Report {
  const repeatWindowMs = options.repeatWindowMs ?? 30_000;
  const slowMs = options.slowMs ?? 1000;
  const rate = rateOf(calls);
  const ops = perOp(calls, slowMs, rate.byOp);
  const findings = [
    ...duplicates(calls, repeatWindowMs),
    ...perRun(calls),
    ...ops.findings,
    ...contention(calls),
    ...unattributed(calls),
  ]
    .filter((f) => f.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  return {
    from: calls.length ? Math.min(...calls.map((c) => c.start)) : null,
    to: calls.length ? Math.max(...calls.map(endOf)) : null,
    calls: calls.length,
    userFacingCalls: calls.filter(isUserFacing).length,
    findings,
    origins: originsOf(calls),
    ops: ops.rows,
    rate: rate.rows,
  };
}
