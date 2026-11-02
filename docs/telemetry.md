# Local session observability

Open [Revv sessions in Grafana](http://localhost:3000/d/revv-overview) for
throughput, latency, errors, agent generations and individual trace waterfalls.
The custom collector UI has been replaced by provisioned Grafana dashboards.
Grafana's Infinity data source queries the existing DuckDB archive directly;
collection, session correlation and weekly exports share that archive.

Start Docker, then run `bun run observability:up` and `bun run dev:collector`.
`make dev` and `make dev-desktop` start Grafana automatically. The collector
launcher reuses a healthy collector already running on the machine, so development
sessions and the installed app can share persistent collection.

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:45680` in the server's
environment to export Revv spans. `make dev-desktop` enables export automatically.
The collector accepts OTLP/HTTP JSON at `/v1/traces` and exposes its query API on
that address. Its root redirects to Grafana (override `COLLECTOR_GRAFANA_URL`
for a different frontend address).

Browser access is limited to the localhost/127.0.0.1 development frontend on
port 5173, Grafana on port 3000, and Tauri's local origins. Foreign origins and
unrecognized hostnames are rejected, including on ingestion. Native exporters
and Grafana's `host.docker.internal` proxy can query without an Origin header.
Malformed spans are reported as OTLP partial rejections while valid siblings
are committed; malformed batch containers return 400. Storage failures return
503 with Retry-After so exporters can retry the idempotent batch.

Grafana binds to loopback port 3000 and allows local viewing without signing in.
Admin login is `admin`; its generated password lives in
`~/.revv/telemetry/grafana-admin-password`. Configuration is copied to
`~/.revv/telemetry/grafana-stack` so archiving this workspace does not break its
mounts. Docker restarts Grafana when its engine starts. `bun run observability:down`
stops it while preserving its Docker volume and the independent trace archive.

Edit `scripts/generate-grafana-dashboards.ts`, then run it with Bun to regenerate
the checked-in dashboards. Run `bun run observability:up` to copy updates into
the persistent configuration. `bun run observability:check` checks all panels
against the running archive, including native trace fields and span metadata.
The archive must contain at least one trace for that check.

Claude Code ACP subprocesses also export native interaction, model-request and
tool spans when a destination is configured. Defaults use JSON and one-second
batching. Existing exporter settings and explicit opt-outs are preserved.
This requires a Claude Code version supporting enhanced telemetry. Other ACP
agents retain Revv's tool and lifecycle instrumentation; their private model
requests are not exposed by ACP.

Walkthrough prompt spans carry `gen_ai.conversation.id`. The trace query joins
Claude spans by session ID and turn window, preserving their stored trace IDs.
The returned display edges are marked `revv.correlation`; they do not claim
native distributed parent propagation. A pooled subprocess never receives a
fixed `TRACEPARENT`, which would attach later turns to an expired parent.
Wall-clock attribution merges overlapping native/ACP observations so a tool is
not counted twice. Unobserved agent time is not proof of model inference.

## Weekly review

The default retention is 14 days, capped at one million spans. The cap can prune
earlier on busy machines. Override `COLLECTOR_RETENTION_DAYS`,
`COLLECTOR_MAX_SPANS` and `COLLECTOR_DB_PATH` in the collector environment.
Keep the database outside disposable workspaces for persistent collection.

Run `bun scripts/export-telemetry.ts > .context/weekly-telemetry.json` for a
seven-day evidence bundle. It includes aggregate timings/errors and bounded
samples of slow spans, errors, generations and traces. Read the complete spans
of an interesting trace at `/api/trace/<traceId>`. Grafana's time picker and the API's `from`/`to` epoch-millisecond parameters
select historical intervals. Query windows support up to 30 days. Native token counts and orchestration totals can describe the same
usage; do not add every level together.

Walkthrough `tool_call_count` counts successful mutating MCP calls, once per
call even when it emits several content or phase events. Reads, failed calls,
completion validation, and heartbeats are excluded; successful idempotent
replays count as calls. Walkthrough `ttft_ms` starts when the first ACP prompt
is sent and ends on the first nonempty text or reasoning delta. Runs without
streamed text omit it rather than reporting synthetic startup as model output.

On Alex's machine the collector runs as `com.revv.collector` at login, with its
database and logs in `~/.revv/telemetry/`. The installed server exports to the
same collector using the environment in `desktop-server.json`. Its older server needed a local OTLP processor
patch; originals are in `~/.revv/telemetry/backups/`. An app update can replace
that patch or its server configuration; rerun
`python3 ~/.revv/telemetry/setup.py` after updating until the app ships this
instrumentation. The collector is an independent bundle and survives workspace
removal. Prompt text and tool content are not enabled by this setup.

For continuous profiles, bounded CPU captures, benchmark comparisons and the
weekly agent workflow, see [Performance investigations](performance.md).
