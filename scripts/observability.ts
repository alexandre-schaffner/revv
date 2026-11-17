import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Run the provisioned stack from durable machine storage, so archiving a
// workspace does not break Grafana's configuration mounts after a restart.
const state = join(homedir(), ".revv", "telemetry");
const stack = join(state, "grafana-stack");
const action = process.argv[2] ?? "up";
if (action !== "up" && action !== "down") throw new Error("Use up or down");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this launcher switch does not affect any cached Turbo task
if (action === "up" && process.env.REVV_SKIP_OBSERVABILITY === "1") {
  console.log("Skipping telemetry dashboards (REVV_SKIP_OBSERVABILITY=1).");
  process.exit(0);
}
if (action === "up") {
  await mkdir(state, { recursive: true });
  const password = join(state, "grafana-admin-password");
  try {
    await access(password);
  } catch {
    await writeFile(password, `${crypto.randomUUID()}${crypto.randomUUID()}\n`, { mode: 0o600 });
  }
  await cp(join(import.meta.dir, "../observability"), stack, { recursive: true });
}
const child = Bun.spawn(
  [
    "docker",
    "compose",
    "-f",
    join(stack, "compose.yaml"),
    ...(action === "up" ? ["up", "-d", "--wait"] : ["down"]),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const code = await child.exited;
if (code !== 0) process.exit(code);
if (action === "up") console.log("Revv Grafana: http://localhost:3000/d/revv-overview");
