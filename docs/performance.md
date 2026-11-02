# Performance investigations for agents

Start here when asked to review session performance or improve a bottleneck.
The tools collect evidence and verify a proposed fix. They do not launch an AI
agent, schedule one, merge code, or mutate the installed app's data.

## Collect the evidence

Run `bun run observability:up` and ensure the collector is running. Then:

```sh
bun run perf:review
```

This writes a new directory under `~/.revv/telemetry/reviews/` containing
`report.md`, `report.json` and `evidence.json`. Use `--out <new-directory>` for a
workspace-local capture, and `--days 7` for adjacent weekly windows (maximum 14
days per window). Raw evidence contains both operation summaries, bounded slow
and error examples, and profile frames. The report includes ranked operations
and the hottest sampled stack locations. An unavailable profile backend is
reported explicitly; it does not discard trace evidence.

Treat rankings as investigation candidates. Aggregate span time overlaps across
parents, children and concurrent work; it is not CPU usage. Historical P95 changes
can reflect a different PR, model, cache state or request mix. Five observations
are enough to nominate a candidate, not establish a regression. Collection gaps
and retention can leave the previous window incomplete. Do not interpret missing
history as zero latency. Use trace IDs in `evidence.json` to inspect examples in
[Grafana sessions](http://localhost:3000/d/revv-overview).

## Continuous sampled stacks

Open [Revv CPU profiles](http://localhost:3000/d/revv-profiles). Filter by `dev`
or `installed`, and align the time picker with an interesting trace window.
The two dashboards link to each other while preserving the selected interval.
The provisioned Pyroscope data source also supports Grafana Explore.

Set `REVV_PYROSCOPE_ENDPOINT=http://127.0.0.1:4040` in a server's environment to
opt in. The server's Effect runtime owns one sampler: 100 Hz, rotating 30-second
windows, with a one-second pause between captures. Each export has a five-second
timeout. A failed export drops that window and logs a warning; there is no retry
queue that could grow during an outage. Runtime disposal cancels the capture.
The destination must be loopback HTTP. No debugger port is opened.

The local Docker stack stores profiles in `revv-pyroscope-data`, with 14-day
retention and 14-day query windows. Docker must be running. An app process can
keep running when Pyroscope is down; those profile windows are lost. Changing
`observability/pyroscope.yaml` requires copying the stack with
`bun run observability:up` and restarting its Pyroscope container.

On this Mac, `bun run perf:install` configures the installed server through
`desktop-server.json` and saves its prior configuration in `~/.revv/telemetry/backups/`.
It takes effect when Revv restarts; `--restart` restarts the app immediately.
Older installed builds receive an independent bundled preload under
`~/.revv/telemetry/profiling/`; the installer removes its own preload once the
installed source owns `ContinuousProfilingLive`. Rerun after an app update that
replaces the server configuration. Installs that have not migrated to desktop
ownership still use the legacy LaunchAgent. Do not preload it into a build that already starts the
native layer: JavaScriptCore has one sampling profiler per process.

These are **Bun JavaScript stack samples**, not native stacks of every process.
They do not profile the Tauri Rust shell, WebView, DuckDB native internals, or
Claude/OpenCode subprocesses. Source locations are recorded, not source text or
locals. Time-window association is not per-span CPU attribution. Pyroscope
normalizes sample counts into estimated CPU nanoseconds; cross-check actual
process CPU and end-to-end latency, especially around idle/GC/native work.

The implementation uses Bun's [sampling profiler](https://bun.sh/reference/bun/jsc/profile)
and Pyroscope's [folded-stack ingestion API](https://grafana.com/docs/pyroscope/latest/reference-server-api/).

## Reproduce, profile, change, compare

Choose one candidate with an actionable local cause. Classify it first:
CPU-bound JS, native work, I/O, database, repeated work, or remote agent/model
latency. Use a representative fixture or a targeted load test. Avoid optimizing
our TypeScript to compensate for a provider outage or a long-running agent turn.

Two deterministic workloads are supplied as examples:
`otlp` exercises production OTLP parsing on 500 synthetic spans;
`diff-anchors` exercises production comment-anchor parsing on 100 synthetic hunks.
They never start the app server or open an application DB.

```sh
bun run perf:bench --workload otlp --out .context/perf/baseline.json
bun run perf:profile --workload otlp --out .context/perf/stacks
# Change the implicated production code, preserving behavior.
bun run perf:bench --workload otlp --out .context/perf/candidate.json
bun run perf:compare .context/perf/baseline.json .context/perf/candidate.json
```

The bounded profile contains `stacks.cpuprofile` for DevTools,
`stacks.md` for agents, a capture record and a diagnostic measurement.
Bun's [CPU profiling flags](https://bun.sh/docs/project/benchmarking) power this
capture. It runs in a fresh process, with a 30-second harness budget and a
60-second parent timeout. A timed-out capture is incomplete, not a success.
Outputs refuse to overwrite prior evidence. Profiling uses a separate run;
never compare instrumented timings to an unprofiled baseline.

Benchmarks run five warmup batches and 25 measured batches by default, with
200 workload iterations per batch. `--runs` accepts 15–100 and `--batch` accepts
1–1000. Compare only the same workload/fixture, output hash, runtime, machine,
batch, warmup and sample count. Capture source revision, dirty state and tracked
diff fingerprint with each measurement. Correctness hashes are calculated
outside timed sections. Add a regression test for the behavior being optimized;
a hash alone does not establish the production contract.

The comparison emits `improved` (exit 0), `regressed` (1), or `inconclusive` (2).
It requires a 10% median gain, separated middle quartiles, no >5% P95 regression,
and median absolute deviation <=10% in both captures to call an improvement.
These are conservative heuristics, not a statistical significance test. Alternate
baseline and candidate runs on an otherwise quiet machine to check drift. An
unchanged-code control should not show a repeatable improvement. Rerun noisy or
inconclusive captures; do not lower thresholds to manufacture a win.

For a new bottleneck, add a workload in `scripts/performance/workloads.ts` that
calls the actual production function. Keep its fixture identity fixed while
optimizing. Do not replace the workload with a faster stub, decrease the input,
skip correctness checks, or change the harness between baseline and candidate.
For async or end-to-end work, build a representative integration benchmark;
these synchronous workloads cannot establish an I/O latency improvement.

## Autonomous weekly investigation contract

A recurring agent can be given this prompt:

> Read docs/performance.md and run bun run perf:review. Investigate the highest
> actionable candidate using its trace evidence and sampled stacks. Add a
> representative reproduction, capture an unprofiled baseline and a separate
> stack profile, then make one focused change. Preserve the SQLite/MCP lifecycle
> invariants, retry budgets, correctness and agent-path parity. Compare equivalent
> before/after measurements and check the original user-visible behavior. Retain
> a fix only with reproducible benefit and passing correctness tests. If evidence
> is absent or inconclusive, record the finding and propose the next experiment.
> Run the full local CI pipeline and perf:test. Produce a reviewable diff with the
> hypothesis, artifacts, gains, noise, tradeoffs and remaining uncertainty.

Store an investigation record beside the artifacts: candidate and trace IDs,
hypothesis, reproduction command, baseline/profile/candidate paths, comparison,
correctness test and CI results. Link large local artifacts instead of copying
raw traces into a PR. Keep changes isolated from unrelated workspace edits.
Scheduling the agent belongs to the caller; these commands do not select a model
or silently install an autonomous code-changing daemon.
