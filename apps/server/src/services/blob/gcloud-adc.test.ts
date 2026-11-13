import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "revv-adc-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gcloud"), "#!/bin/sh\nsleep 0.5\nexit 0\n");
  chmodSync(join(bin, "gcloud"), 0o755);
  const adcDir = join(root, ".config", "gcloud");
  mkdirSync(adcDir, { recursive: true });
  writeFileSync(join(adcDir, "application_default_credentials.json"), "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A child process: Bun reads PATH and HOME once at startup.
test("the gcloud token probe doesn't block the event loop while it runs", async () => {
  const script = `
    const { adcStatus } = await import(${JSON.stringify(join(import.meta.dir, "gcloud-adc.ts"))});
    const started = performance.now();
    const pending = adcStatus();
    const blockedMs = performance.now() - started;
    console.log(JSON.stringify({ blockedMs, status: await pending }));
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: `${join(root, "bin")}:/bin:/usr/bin`, HOME: root },
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const { blockedMs, status } = JSON.parse(out);
  expect(blockedMs).toBeLessThan(250);
  expect(status.available).toBe(true);
  expect(status.source).toBe("default");
});
