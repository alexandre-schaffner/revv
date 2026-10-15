import { mkdir, writeFile } from "node:fs/promises";
import { cpus, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { measurement, quantile } from "./model";
import { hash, workload } from "./workloads";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    workload: { type: "string", default: "otlp" },
    out: { type: "string" },
    runs: { type: "string", default: "25" },
    batch: { type: "string", default: "200" },
    profiled: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("Provide --out <new JSON path>");
const runs = Number(values.runs);
const batch = Number(values.batch);
if (
  !Number.isInteger(runs) ||
  runs < 15 ||
  runs > 100 ||
  !Number.isInteger(batch) ||
  batch < 1 ||
  batch > 1000
) {
  throw new Error("Use 15–100 runs and a batch size of 1–1000");
}
const selected = workload(values.workload);
const warmups = 5;
const outputHash = hash(JSON.stringify(selected.run()));
const samplesMs: number[] = [];
const started = Date.now();
for (let index = 0; index < warmups + runs; index++) {
  if (Date.now() - started > 30_000)
    throw new Error("Benchmark exceeded its 30-second budget; reduce batch size");
  const start = performance.now();
  for (let iteration = 0; iteration < batch; iteration++) selected.run();
  const elapsed = performance.now() - start;
  if (index >= warmups) samplesMs.push(elapsed);
}
if (hash(JSON.stringify(selected.run())) !== outputHash)
  throw new Error("Nondeterministic workload output");
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: resolve(import.meta.dir, "../..") });
  if (result.exitCode !== 0) throw new Error("Unable to capture Git provenance");
  return result.stdout.toString().trim();
};
const artifact = {
  ...measurement({
    version: 1,
    workload: selected.id,
    fixtureHash: selected.fixtureHash,
    outputHash,
    batch,
    warmups,
    profiled:
      values.profiled ||
      process.execArgv.some((flag) => flag.startsWith("--cpu-prof")) ||
      process.env.BUN_CPU_PROFILE === "1" ||
      /--cpu-prof/.test(process.env.BUN_OPTIONS ?? ""),
    runtime: Bun.version,
    machine: hash(
      JSON.stringify([hostname(), process.platform, process.arch, cpus()[0]?.model, cpus().length]),
    ),
    samplesMs,
  }),
  generatedAt: new Date().toISOString(),
  revision: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain"]) !== "",
  diffHash: hash(git(["diff", "HEAD"])),
  note: "Milliseconds per batch. Timings under a CPU sampler are diagnostic only.",
};
await mkdir(dirname(resolve(values.out)), { recursive: true });
await writeFile(values.out, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
console.log(
  `${selected.id}: median ${quantile(samplesMs, 0.5).toFixed(2)}ms/batch → ${values.out}`,
);
