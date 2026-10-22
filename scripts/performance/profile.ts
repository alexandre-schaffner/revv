import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    workload: { type: "string", default: "otlp" },
    out: { type: "string" },
  },
});
if (!values.out) throw new Error("Provide --out <new profile directory>");
const output = resolve(values.out);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
// Reserve a new capture. Never replace a prior investigation's evidence.
await writeFile(
  `${output}/capture.json`,
  JSON.stringify({ startedAt: new Date().toISOString(), workload: values.workload }),
  { flag: "wx" },
);
const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    "--cpu-prof",
    "--cpu-prof-md",
    "--cpu-prof-name",
    "stacks",
    "--cpu-prof-dir",
    output,
    resolve(import.meta.dir, "benchmark.ts"),
    "--workload",
    values.workload,
    "--profiled",
    "--out",
    `${output}/measurement.json`,
  ],
  { stdout: "inherit", stderr: "inherit", timeout: 60_000 },
);
const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const code = await child.exited;
process.removeListener("SIGINT", stop);
process.removeListener("SIGTERM", stop);
if (code !== 0)
  throw new Error(`Profiler failed (exit ${code}); incomplete capture retained at ${output}`);
const profile: unknown = JSON.parse(await readFile(`${output}/stacks.cpuprofile`, "utf8"));
if (
  typeof profile !== "object" ||
  profile === null ||
  !("nodes" in profile) ||
  !Array.isArray(profile.nodes) ||
  profile.nodes.length === 0
) {
  throw new Error("Bun did not produce a usable CPU profile");
}
console.log(`CPU stacks captured in ${output}`);
