import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateUserPath, refreshUserPath, resolveCommandPath, resolveUserPath } from "./host";

const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateUserPath();
});

function binDir(): string {
  return mkdtempSync(join(tmpdir(), "revv-host-"));
}

function executable(dir: string, name: string, mode = 0o755): string {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, mode);
  return file;
}

describe("resolveCommandPath", () => {
  it("answers like `which`: the first executable file on the PATH", () => {
    const shadow = binDir();
    const notExecutable = binDir();
    const real = binDir();
    mkdirSync(join(shadow, "tool"));
    executable(notExecutable, "tool", 0o644);
    const expected = executable(real, "tool");
    process.env.PATH = [shadow, notExecutable, real].join(":");
    delete process.env.SHELL;
    invalidateUserPath();

    expect(resolveCommandPath("tool")).toBe(expected);
    expect(resolveCommandPath("missing-tool")).toBeNull();
  });
});

describe("resolveUserPath", () => {
  it("refreshes in the background, so a refresh is seen by the next read", async () => {
    const first = binDir();
    process.env.PATH = first;
    delete process.env.SHELL;
    invalidateUserPath();
    expect(resolveUserPath().split(":")).toContain(first);

    const second = binDir();
    process.env.PATH = second;
    // Still cached: the PATH change isn't seen until a refresh lands.
    expect(resolveUserPath().split(":")).not.toContain(second);
    await refreshUserPath();
    expect(resolveUserPath().split(":")).toContain(second);
  });
});
