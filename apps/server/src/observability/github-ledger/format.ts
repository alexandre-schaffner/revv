import type { Report } from "./analyze";
import type { GitHubCall } from "./record";

const ms = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const lpad = (s: string, n: number) => s.padStart(n);

function table(header: readonly string[], widths: readonly number[], rows: readonly string[][]) {
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => (i === 0 ? pad(c, widths[i] ?? 10) : lpad(c, widths[i] ?? 8))).join("  ");
  return [line(header), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)].join("\n");
}

export function formatReport(report: Report, options: { findings?: number } = {}): string {
  const out: string[] = [];
  const span = report.from !== null && report.to !== null ? report.to - report.from : 0;
  out.push(
    `GitHub calls: ${report.calls} (${report.userFacingCalls} user-facing) over ${ms(span)}` +
      (report.from !== null ? `, from ${new Date(report.from).toISOString()}` : ""),
  );

  out.push("", "FINDINGS (ranked by estimated waiting caused)");
  const findings = report.findings.slice(0, options.findings ?? 25);
  if (findings.length === 0) out.push("  none");
  findings.forEach((f, i) => {
    out.push("", `${i + 1}. [${f.kind}] ~${ms(f.cost)}  ${f.title}`);
    for (const e of f.evidence) out.push(...e.split("\n").map((l) => `     ${l}`));
    out.push(`     fix: ${f.fix}`);
  });
  if (report.findings.length > findings.length) {
    out.push("", `  … ${report.findings.length - findings.length} more (--findings N)`);
  }

  out.push(
    "",
    "BY ORIGIN",
    table(
      ["origin", "kind", "runs", "calls", "p50 run", "p95 run", "max run"],
      [44, 10, 5, 6, 8, 8, 8],
      report.origins.map((o) => [
        o.label,
        o.kind,
        String(o.runs),
        String(o.calls),
        ms(o.p50RunMs),
        ms(o.p95RunMs),
        ms(o.maxRunMs),
      ]),
    ),
  );

  out.push(
    "",
    "BY OPERATION",
    table(
      ["operation", "calls", "p50", "p95", "max", "304", "avg KB", "points", "errs", "mostly from"],
      [52, 6, 7, 7, 7, 5, 7, 7, 5, 36],
      report.ops.map((o) => [
        o.op,
        String(o.calls),
        ms(o.p50Ms),
        ms(o.p95Ms),
        ms(o.maxMs),
        `${Math.round(o.notModified * 100)}%`,
        String(Math.round(o.avgBytes / 1024)),
        String(o.points),
        String(o.errors),
        o.origins.join(", "),
      ]),
    ),
  );

  if (report.rate.length > 0) {
    out.push(
      "",
      "RATE BUDGET BURNED (x-ratelimit-used deltas; GraphQL includes other clients on the same token)",
    );
    for (const r of report.rate) {
      out.push(
        `  ${r.resource} (account ${r.account}): ${r.used} point(s)` +
          (r.outside ? ` + ${r.outside} by other clients` : "") +
          `; ${r.remaining}/${r.limit} left` +
          (r.byOrigin.length
            ? ` — ${r.byOrigin.map((o) => `${o.label} ${o.used}`).join(", ")}`
            : ""),
      );
    }
  }
  return out.join("\n");
}

export function formatTimeline(calls: readonly GitHubCall[], width = 60): string {
  if (calls.length === 0) return "no calls";
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  const t0 = sorted[0]?.start ?? 0;
  const end = Math.max(...sorted.map((c) => c.start + (c.durationMs ?? c.ttfbMs ?? 0)));
  const scale = width / Math.max(1, end - t0);
  return sorted
    .map((c) => {
      const d = c.durationMs ?? c.ttfbMs ?? 0;
      const from = Math.floor((c.start - t0) * scale);
      const len = Math.max(1, Math.round(d * scale));
      const bar = `${" ".repeat(from)}${(c.error ? "x" : c.status === 304 ? "-" : "█").repeat(len)}`;
      return `${lpad(`+${ms(c.start - t0)}`, 7)} ${pad(bar, width + 1)} ${lpad(ms(d), 7)}  ${pad(c.origin.label, 36)} ${c.op}`;
    })
    .join("\n");
}
