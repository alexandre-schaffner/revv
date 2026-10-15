import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("This installer configures a macOS LaunchAgent");
const output = resolve(homedir(), ".revv/telemetry/profiling");
await mkdir(output, { recursive: true });
const build = Bun.spawn(
  [
    process.execPath,
    "build",
    resolve(import.meta.dir, "../../apps/server/src/observability/profiling-preload.ts"),
    "--target",
    "bun",
    "--outfile",
    `${output}/preload.js`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) throw new Error("Failed to bundle profiling preload");
const install = Bun.spawn(
  ["python3", resolve(import.meta.dir, "install-machine.py"), ...Bun.argv.slice(2)],
  { stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await install.exited;
