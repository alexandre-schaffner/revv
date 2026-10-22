// A bounded weekly evidence bundle for an agent to inspect; prints JSON to stdout.
const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:45680";
const windowMinutes = 7 * 24 * 60;
const endpoints = ["kpis", "summary", "services", "generations", "errors", "slow", "traces"];
const entries = await Promise.all(
  endpoints.map(async (name) => {
    const url = new URL(`/api/${name}`, base);
    url.searchParams.set("window", String(windowMinutes));
    url.searchParams.set("limit", "100");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return [name, await response.json()] as const;
  }),
);
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      windowMinutes,
      // Samples are bounded; operation summaries aggregate the entire window.
      sampleLimit: 100,
      ...Object.fromEntries(entries),
    },
    null,
    2,
  ),
);
