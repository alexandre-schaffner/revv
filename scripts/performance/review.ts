import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { rankCandidates, summaries } from "./model";
import { hotFrames } from "./profiles";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string" },
    days: { type: "string", default: "7" },
    collector: { type: "string", default: "http://127.0.0.1:45680" },
    grafana: { type: "string", default: "http://127.0.0.1:3000" },
  },
});
const days = Number(values.days);
if (!Number.isFinite(days) || days <= 0 || days > 14) throw new Error("Use --days > 0 and <= 14");
const untilMs = Date.now();
const width = days * 86400000;
const from = untilMs - width;
const json = async (endpoint: string, start: number, end: number): Promise<unknown> => {
  const url = new URL(`/api/${endpoint}`, values.collector);
  url.searchParams.set("from", String(start));
  url.searchParams.set("to", String(end));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Collector ${endpoint}: HTTP ${response.status}`);
  return response.json();
};
const [current, previous, errors, slow] = await Promise.all([
  json("summary", from, untilMs),
  json("summary", from - width, from - 1),
  json("errors", from, untilMs),
  json("slow", from, untilMs),
]);
const candidates = rankCandidates(summaries(current), summaries(previous));
const profileWindow = async (start: number, end: number) => {
  try {
    const response = await fetch(new URL("/api/ds/query", values.grafana), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: String(start),
        to: String(end),
        queries: [
          {
            refId: "A",
            datasource: { uid: "revv-profiles", type: "grafana-pyroscope-datasource" },
            queryType: "profile",
            profileTypeId: "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
            labelSelector: '{service_name="revv-server",runtime="bun"}',
            groupBy: [],
            maxNodes: 2000,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Grafana profiles: HTTP ${response.status}`);
    const raw: unknown = await response.json();
    const frames = hotFrames(raw);
    return { status: frames.length ? "available" : "no-samples", hotFrames: frames, raw };
  } catch (error) {
    return { status: "unavailable", reason: String(error) };
  }
};
const [currentProfiles, previousProfiles] = await Promise.all([
  profileWindow(from, untilMs),
  profileWindow(from - width, from - 1),
]);
const output = resolve(
  values.out ??
    join(
      homedir(),
      ".revv/telemetry/reviews",
      `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}`,
    ),
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  currentWindow: { from, to: untilMs },
  previousWindow: { from: from - width, to: from - 1 },
  candidates,
  profiles: {
    current: { ...currentProfiles, raw: undefined },
    previous: { ...previousProfiles, raw: undefined },
  },
  caveats: [
    "Ranked aggregate span time overlaps; it is not CPU time.",
    "Historical comparisons are observational: workload mix, volume, agent/model and cache warmth may differ.",
    "The previous window may be incomplete due to retention or collection gaps; absence is not zero cost.",
    "Slow/error examples are capped at 100 each. Profiles cover the Bun process, not its agent subprocesses or WebView.",
  ],
  next: "Read docs/performance.md. Reproduce one candidate, profile it, and compare equivalent unprofiled benchmarks before retaining a fix.",
};
await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
});
await writeFile(
  join(output, "evidence.json"),
  `${JSON.stringify({ current, previous, errors, slow, currentProfiles, previousProfiles }, null, 2)}\n`,
  { flag: "wx" },
);
const markdown = [
  "# Revv performance review",
  "",
  `Window: ${new Date(from).toISOString()} → ${new Date(untilMs).toISOString()}`,
  "",
  "| Service | Operation | Calls | P95 ms | Aggregate span ms | P95 change |",
  "| --- | --- | ---: | ---: | ---: | ---: |",
  ...candidates.map(
    (row) =>
      `| ${row.serviceName.replaceAll("|", "\\|")} | ${row.name.replaceAll("|", "\\|")} | ${row.count} | ${row.p95.toFixed(1)} | ${row.aggregateSpanMs.toFixed(1)} | ${row.p95ChangePercent?.toFixed(1) ?? "unknown"}% |`,
  ),
  "",
  ...report.caveats.map((line) => `- ${line}`),
  "",
  report.next,
  "",
].join("\n");
await writeFile(join(output, "report.md"), markdown, { flag: "wx" });
console.log(`${candidates.length} investigation candidates → ${output}/report.md`);
