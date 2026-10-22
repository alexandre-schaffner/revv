// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Grafana expands these template variables at query time.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Provisioned dashboards are generated from the collector's field contract.
// Run this after changing panels; the generated JSON is checked in alongside it.
const datasource = { type: "yesoreyeram-infinity-datasource", uid: "revv-sessions" };
const base = "http://host.docker.internal:45680/api/";
const range = "from=${__from}&to=${__to}&service=${service:percentencode}";
type Column = { selector: string; text: string; type: string };
const col = (selector: string, text = selector, type = "string"): Column => ({
  selector,
  text,
  type,
});
function query(endpoint: string, columns: Column[], format = "table", root = ".") {
  return {
    refId: "A",
    datasource,
    type: "json",
    parser: "jq-backend",
    source: "url",
    format,
    url: `${base}${endpoint}${endpoint.includes("?") ? "&" : "?"}${range}`,
    url_options: { method: "GET" },
    root_selector: root,
    columns,
  };
}
const traceLink = {
  title: "Open trace",
  targetBlank: false,
  url: "/d/revv-trace/revv-trace?var-traceId=${__value.raw}&${__url_time_range}",
};
const override = (name: string, id: string, value: unknown) => ({
  matcher: { id: "byName", options: name },
  properties: [{ id, value }],
});
const traceColumns = [
  col("traceId"),
  col("name", "Operation"),
  col("serviceName", "Service"),
  col("startMs", "Started", "timestamp_epoch"),
  col("durationMs", "Duration", "number"),
  col("statusMessage", "Error"),
];
let id = 0;
function panel(
  title: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  target: ReturnType<typeof query>,
  unit = "short",
) {
  return {
    id: ++id,
    title,
    type,
    gridPos: { x, y, w, h },
    datasource,
    targets: [target],
    fieldConfig: {
      defaults: {
        unit,
        noValue: "—",
        color: { mode: "palette-classic" },
        custom: { lineWidth: 2 },
      },
      overrides: [
        ...[
          ["Errors", "red"],
          ["Spans", "blue"],
          ["P50", "blue"],
          ["P95", "purple"],
        ].map(([name = "", color = ""]) =>
          override(name, "color", { mode: "fixed", fixedColor: color }),
        ),
        override("traceId", "links", [traceLink]),
        override("Duration", "unit", "ms"),
        override("P50", "unit", "ms"),
        override("P95", "unit", "ms"),
        override("Error rate", "unit", "percentunit"),
      ],
    },
    options:
      type === "stat"
        ? {
            reduceOptions: { calcs: ["lastNotNull"], values: false },
            textMode: "auto",
            colorMode: "value",
          }
        : type === "table"
          ? {
              showHeader: true,
              cellHeight: "sm",
              sortBy: [{ displayName: "P95", desc: true }],
            }
          : { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } },
  };
}
const serviceVariable = {
  name: "service",
  label: "Service",
  type: "query",
  datasource,
  refresh: 2,
  includeAll: true,
  allValue: "all",
  multi: false,
  current: { text: "All", value: "$__all" },
  query: {
    queryType: "infinity",
    refId: "service",
    infinityQuery: {
      ...query("services", [col("serviceName", "__text"), col("serviceName", "__value")]),
      url: `${base}services?from=\${__from}&to=\${__to}`,
    },
  },
};
const links = [
  { title: "Sessions", type: "link", url: "/d/revv-overview?${__url_time_range}" },
  { title: "Profiles", type: "link", url: "/d/revv-profiles?${__url_time_range}" },
];
const common = {
  links,
  schemaVersion: 39,
  version: 1,
  editable: false,
  tags: ["revv", "observability"],
  timezone: "browser",
  refresh: "30s",
  time: { from: "now-24h", to: "now" },
};
const stats = [
  ["Spans", "spanCount", "short"],
  ["Traces", "traceCount", "short"],
  ["Error rate", "errorRate", "percentunit"],
  ["Walkthrough median", "walkthroughGenMedianMs", "ms"],
  ["GitHub P95", "githubP95Ms", "ms"],
  ["First response median", "ttftMedianMs", "ms"],
];
const overview = {
  ...common,
  uid: "revv-overview",
  title: "Revv sessions",
  description:
    "Development and installed-app sessions from the local archive. Use the time picker for weekly reviews; select a trace ID to inspect its waterfall.",
  templating: { list: [serviceVariable] },
  panels: [
    ...stats.map(([title = "", field = "", unit = "short"], i) =>
      panel(
        title,
        "stat",
        i * 4,
        0,
        4,
        4,
        query("kpis", [col(field, title, "number")], "table", "[.]"),
        unit,
      ),
    ),
    panel(
      "Span throughput and errors",
      "timeseries",
      0,
      4,
      12,
      8,
      query(
        "timeseries",
        [
          col("bucketMs", "Time", "timestamp_epoch"),
          col("count", "Spans", "number"),
          col("errorCount", "Errors", "number"),
        ],
        "timeseries",
      ),
    ),
    panel(
      "Latency distribution",
      "timeseries",
      12,
      4,
      12,
      8,
      query(
        "timeseries",
        [
          col("bucketMs", "Time", "timestamp_epoch"),
          col("p50", "P50", "number"),
          col("p95", "P95", "number"),
        ],
        "timeseries",
      ),
      "ms",
    ),
    panel(
      "Agent generations",
      "table",
      0,
      12,
      24,
      8,
      query("generations?limit=100", [
        col("traceId"),
        col("kind", "Kind"),
        col("startMs", "Started", "timestamp_epoch"),
        col("durationMs", "Duration", "number"),
        col("model", "Model"),
        col("toolCallCount", "Content writes", "number"),
        col("inputTokens", "Input tokens", "number"),
        col("outputTokens", "Output tokens", "number"),
        col("statusCode", "Status", "number"),
      ]),
    ),
    panel(
      "Operations",
      "table",
      0,
      20,
      24,
      10,
      query("summary", [
        col("name", "Operation"),
        col("serviceName", "Service"),
        col("category", "Category"),
        col("count", "Calls", "number"),
        col("p50", "P50", "number"),
        col("p95", "P95", "number"),
        col("errorCount", "Errors", "number"),
        col("errorRate", "Error rate", "number"),
      ]),
    ),
    panel("Recent errors", "table", 0, 30, 12, 9, query("errors?limit=100", traceColumns)),
    panel("Slow operations", "table", 12, 30, 12, 9, query("slow?limit=100", traceColumns)),
    panel(
      "Recent traces — select a trace ID to inspect",
      "table",
      0,
      39,
      24,
      9,
      query("traces?limit=100", [
        col("traceId"),
        col("rootName", "Operation"),
        col("serviceName", "Service"),
        col("startMs", "Started", "timestamp_epoch"),
        col("durationMs", "Duration", "number"),
        col("spanCount", "Spans", "number"),
        col("errorCount", "Errors", "number"),
      ]),
    ),
  ],
};

// Grafana's trace panel expects one display trace. Session-correlated spans may
// retain separate stored trace IDs; preserve those IDs in tags for inspection.
const traceRows =
  'map({traceID: "${traceId}", spanID: .spanId, parentSpanID: (.parentSpanId // ""), startTime: .startMs, duration: .durationMs, serviceName: .serviceName, operationName: .name, statusCode: .statusCode, statusMessage: .statusMessage, tags: ((.attributes + {"original.trace_id": .traceId}) | to_entries)})';
const trace = {
  ...common,
  uid: "revv-trace",
  title: "Revv trace",
  refresh: "",
  description:
    "Trace waterfall including MCP calls and session-correlated native agent spans. Original trace IDs are retained in span tags.",
  templating: {
    list: [
      {
        name: "traceId",
        label: "Trace ID",
        type: "textbox",
        current: { text: "select-a-trace", value: "select-a-trace" },
      },
    ],
  },
  panels: [
    {
      ...panel("Trace waterfall", "traces", 0, 0, 24, 20, {
        ...query("trace/${traceId:percentencode}", [], "trace", traceRows),
        url: `${base}trace/\${traceId:percentencode}`,
      }),
      // Infinity emits complex cells as JSON strings; Grafana's trace viewer
      // consumes an array of key/value tags.
      transformations: [
        {
          id: "convertFieldType",
          options: { conversions: [{ targetField: "tags", destinationType: "other" }] },
        },
      ],
      options: {},
    },
    panel("Span details", "table", 0, 20, 24, 12, {
      ...query("trace/${traceId:percentencode}", [col("spanId", "Span ID"), ...traceColumns]),
      url: `${base}trace/\${traceId:percentencode}`,
    }),
  ],
};
const profiles = {
  ...common,
  uid: "revv-profiles",
  title: "Revv CPU profiles",
  description:
    "Bun JavaScript stacks sampled at 100 Hz. Time-window association with traces, not per-span CPU attribution. Agent subprocesses, native Rust and WebView are separate processes.",
  templating: {
    list: [
      {
        name: "channel",
        label: "Channel",
        type: "custom",
        query: "dev,installed",
        includeAll: true,
        allValue: ".*",
        current: { text: "All", value: "$__all" },
      },
    ],
  },
  panels: [
    {
      id: 901,
      title: "Sampled JavaScript stacks",
      type: "flamegraph",
      gridPos: { x: 0, y: 0, w: 24, h: 22 },
      datasource: { type: "grafana-pyroscope-datasource", uid: "revv-profiles" },
      targets: [
        {
          refId: "A",
          datasource: { type: "grafana-pyroscope-datasource", uid: "revv-profiles" },
          queryType: "profile",
          profileTypeId: "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
          labelSelector: '{service_name="revv-server",channel=~"${channel:regex}",runtime="bun"}',
          groupBy: [],
          maxNodes: 1000,
        },
      ],
      options: {},
      fieldConfig: { defaults: {}, overrides: [] },
    },
  ],
};
for (const [name, dashboard] of [
  ["revv-overview", overview],
  ["revv-trace", trace],
  ["revv-profiles", profiles],
] as const) {
  await writeFile(
    join(import.meta.dir, `../observability/grafana/dashboards/${name}.json`),
    `${JSON.stringify(dashboard, null, 2)}\n`,
  );
  const formatted = Bun.spawn(
    [
      "bunx",
      "biome",
      "format",
      "--write",
      join(import.meta.dir, `../observability/grafana/dashboards/${name}.json`),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  if ((await formatted.exited) !== 0) throw new Error(`Could not format ${name}`);
}
console.log("Generated Revv Grafana dashboards");
