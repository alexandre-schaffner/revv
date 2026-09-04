// ── DuckDB schema ────────────────────────────────────────────────────────────
//
// One wide `spans` table. The OTLP-native fields live alongside a handful of
// extracted "hot columns" lifted out of `attributes` so the KPI rollups don't
// pay a JSON-extraction cost on every aggregate. `attributes` keeps the full
// bag for the detail views and anything we didn't promote to a column.
//
// Idempotency is the primary key (trace_id, span_id): a replayed OTLP batch
// (retry, reconnect) is a no-op via INSERT ... ON CONFLICT DO NOTHING.

export const CREATE_SPANS_TABLE = `
CREATE TABLE IF NOT EXISTS spans (
  trace_id        VARCHAR NOT NULL,
  span_id         VARCHAR NOT NULL,
  parent_span_id  VARCHAR,
  name            VARCHAR NOT NULL,
  service_name    VARCHAR NOT NULL,
  start_ms        BIGINT  NOT NULL,
  duration_ms     DOUBLE  NOT NULL,
  status_code     INTEGER NOT NULL DEFAULT 0,
  status_message  VARCHAR,
  attributes      JSON,
  -- extracted hot columns
  walkthrough_id  VARCHAR,
  pr_id           VARCHAR,
  model           VARCHAR,
  provider        VARCHAR,
  tool_call_count INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  http_method     VARCHAR,
  http_path       VARCHAR,
  http_status     INTEGER,
  PRIMARY KEY (trace_id, span_id)
);
`;

// Secondary indexes for the two axes every query slices on: time window and
// operation name. DuckDB keeps these as ART indexes; cheap at our row counts.
export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS spans_start_ms ON spans (start_ms);`,
  `CREATE INDEX IF NOT EXISTS spans_name ON spans (name);`,
];

/** Ordered column list — keep in lockstep with the INSERT in ingest.ts. */
export const SPAN_COLUMNS = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "name",
  "service_name",
  "start_ms",
  "duration_ms",
  "status_code",
  "status_message",
  "attributes",
  "walkthrough_id",
  "pr_id",
  "model",
  "provider",
  "tool_call_count",
  "input_tokens",
  "output_tokens",
  "http_method",
  "http_path",
  "http_status",
] as const;
