import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePackageRunnerDir } from "./package-runner-dir";

describe("ensurePackageRunnerDir", () => {
  // The manifest is what stops npm's walk up for a project root: without it,
  // npm would read whichever parent directory's package.json it found.
  it("creates the directory with a manifest of its own", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-acp-runner-"));
    const dir = join(base, "acp-runner");
    try {
      expect(ensurePackageRunnerDir(dir)).toBe(dir);
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toEqual({
        name: "revv-acp-runner",
        private: true,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("leaves an existing manifest alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revv-acp-runner-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"private":true}\n');
      expect(ensurePackageRunnerDir(dir)).toBe(dir);
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe('{"private":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the directory can't be created", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-acp-runner-"));
    const file = join(base, "not-a-dir");
    try {
      writeFileSync(file, "");
      expect(ensurePackageRunnerDir(join(file, "acp-runner"))).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
