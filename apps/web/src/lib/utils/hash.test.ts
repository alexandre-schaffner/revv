import { describe, expect, it } from "bun:test";
import { hash32 } from "./hash";

describe("hash32", () => {
  it("is the FNV-1a offset basis for the empty string", () => {
    expect(hash32("")).toBe(0x811c9dc5);
  });

  it("is a stable unsigned 32-bit value", () => {
    for (const s of ["octocat", "a", "revv/revv", "Ünïcødé"]) {
      const h = hash32(s);
      expect(h).toBe(hash32(s));
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("keeps the outputs avatar swatches are keyed on", () => {
    expect(hash32("a")).toBe(0xe40c292c);
    expect(hash32("octocat")).toBe(3374515820);
    expect(hash32("octocat")).not.toBe(hash32("Octocat"));
  });
});
