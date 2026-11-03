import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceCommit } from "./build-info";

describe("readSourceCommit", () => {
  it("reads the full SHA of the checkout the server runs from", () => {
    expect(readSourceCommit()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null outside a git checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revv-build-info-"));
    try {
      expect(readSourceCommit(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
