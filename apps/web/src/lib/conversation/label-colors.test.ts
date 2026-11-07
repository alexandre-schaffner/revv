import { describe, expect, it } from "bun:test";
import { labelHue } from "./label-colors";

describe("labelHue", () => {
  it("reads gray as achromatic", () => {
    expect(labelHue("cfd3d7").c).toBeLessThan(0.02);
    expect(labelHue("ffffff").c).toBeLessThan(0.001);
  });

  it("falls back to gray on a malformed color", () => {
    expect(labelHue("nope").c).toBeLessThan(0.001);
  });
});
