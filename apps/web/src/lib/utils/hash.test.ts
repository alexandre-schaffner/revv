import { describe, expect, it } from "bun:test";
import { hash32 } from "./hash";

describe("hash32", () => {
  it("keeps the outputs avatar swatches are keyed on", () => {
    expect(hash32("")).toBe(0x811c9dc5);
    expect(hash32("a")).toBe(0xe40c292c);
    expect(hash32("octocat")).toBe(3374515820);
    expect(hash32("octocat")).not.toBe(hash32("Octocat"));
  });
});
