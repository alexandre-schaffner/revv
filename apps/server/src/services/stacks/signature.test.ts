import { describe, expect, test } from "bun:test";
import { stackSignature } from "./signature";

describe("stackSignature", () => {
  const base = { number: 1, headSha: "a", status: "merged" };
  const middle = { number: 2, headSha: "b", status: "ready" };
  const top = { number: 3, headSha: "c", status: "draft" };
  const layers = [base, middle, top];

  test("ignores merged layers and moves with any open head", () => {
    expect(stackSignature(layers)).toBe(stackSignature([{ ...base, headSha: "z" }, middle, top]));
    expect(stackSignature(layers)).not.toBe(
      stackSignature([base, middle, { ...top, headSha: "d" }]),
    );
  });
});
