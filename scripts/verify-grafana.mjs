// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Substitute Grafana runtime variables for the integration check.
// Checks the running, provisioned dashboards through Grafana's query engine.
// Requires the local collector and `bun run observability:up`.
const grafana = "http://127.0.0.1:3000";
const collector = "http://127.0.0.1:45680";
const to = Date.now();
const from = to - 7 * 24 * 60 * 60_000;
async function json(url, body) {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
const traces = await json(`${collector}/api/traces?window=10080&limit=100`);
const trace = traces.find((entry) => entry.spanCount > 1 && entry.spanCount < 100) ?? traces[0];
if (!trace) throw new Error("The archive needs at least one real trace to verify its viewer");
function interpolate(target) {
  return JSON.parse(
    JSON.stringify(target)
      .replaceAll("${__from}", String(from))
      .replaceAll("${__to}", String(to))
      .replaceAll("${service:percentencode}", "all")
      .replaceAll("${traceId:percentencode}", encodeURIComponent(trace.traceId))
      .replaceAll("${traceId}", trace.traceId)
      .replaceAll("${channel:regex}", ".*"),
  );
}
let checked = 0;
for (const uid of ["revv-overview", "revv-trace", "revv-profiles"]) {
  const { dashboard } = await json(`${grafana}/api/dashboards/uid/${uid}`);
  for (const panel of dashboard.panels) {
    const response = await json(`${grafana}/api/ds/query`, {
      queries: panel.targets.map(interpolate),
      from: String(from),
      to: String(to),
    });
    const result = response.results.A;
    if (result.error || result.status >= 400) throw new Error(`${panel.title}: ${result.error}`);
    for (const frame of result.frames ?? []) {
      if (frame.schema.meta?.custom?.error)
        throw new Error(`${panel.title}: ${frame.schema.meta.custom.error}`);
    }
    if (panel.type === "stat" && !result.frames?.[0]?.schema.fields?.length) {
      throw new Error(`${panel.title}: query returned no fields`);
    }
    if (panel.type === "flamegraph") {
      const frame = result.frames?.[0];
      const fields = frame?.schema.fields?.map((field) => field.name) ?? [];
      for (const name of ["level", "value", "self", "label"]) {
        if (!fields.includes(name)) throw new Error(`Missing flamegraph field: ${name}`);
      }
      if (!frame.data.values[fields.indexOf("value")]?.some((value) => value > 0))
        throw new Error("No continuous profile samples; run a profiled Revv process first");
    }
    if (panel.type === "traces") {
      const frame = result.frames?.[0];
      const names = frame?.schema.fields?.map((field) => field.name) ?? [];
      for (const name of [
        "traceID",
        "spanID",
        "parentSpanID",
        "startTime",
        "duration",
        "operationName",
      ])
        if (!names.includes(name)) throw new Error(`Missing trace field: ${name}`);
      if (frame.schema.meta?.preferredVisualisationType !== "trace")
        throw new Error("Missing native trace visualization");
      if (!frame.data.values[0]?.length) throw new Error("Trace waterfall has no spans");
      const tags = JSON.parse(frame.data.values[names.indexOf("tags")][0]);
      if (!tags.some((tag) => tag.key === "original.trace_id"))
        throw new Error("Missing original trace ID in span tags");
      if (
        !panel.transformations?.some(
          (step) =>
            step.id === "convertFieldType" &&
            step.options.conversions.some(
              (conversion) =>
                conversion.targetField === "tags" && conversion.destinationType === "other",
            ),
        )
      )
        throw new Error("Missing JSON tag conversion for the trace viewer");
    }
    checked++;
  }
}
console.log(
  `Verified ${checked} Grafana panels against the archive, including native trace and continuous profile frames`,
);
