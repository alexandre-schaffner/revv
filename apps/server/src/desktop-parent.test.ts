import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the server shuts down when its desktop parent is force-killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "revv-parent-"));
  const marker = join(root, "stopped");
  const modulePath = join(import.meta.dir, "desktop-parent.ts");
  const childScript = `
    import { watchDesktopParent } from ${JSON.stringify(modulePath)};
    watchDesktopParent(process.ppid, () => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped');
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    console.log(process.pid);
  `;
  const parentScript = `
    const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(childScript)}], { stdout: 'inherit' });
    await child.exited;
  `;
  const parent = Bun.spawn([process.execPath, "-e", parentScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let childPid: number | undefined;
  try {
    const first = await parent.stdout.getReader().read();
    childPid = Number(new TextDecoder().decode(first.value).trim());
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    let stopped = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      stopped = await readFile(marker, "utf8").catch(() => "");
      if (stopped) break;
      await Bun.sleep(100);
    }
    expect(stopped).toBe("stopped");
  } finally {
    parent.kill();
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
