import { describe, expect, it } from "bun:test";
import { chapterNumbersByIndex } from "@revv/shared";

// The chat agent maps the user's "chapter N" through these numbers, so they
// must match the "Chapter N / M" eyebrow GuidedWalkthrough prints: Overview
// unnumbered, visible Phase B chapters 1..M in index order.
describe("chapterNumbersByIndex", () => {
  it("numbers the first Phase B chapter 1, not 0 or 2", () => {
    const numbers = chapterNumbersByIndex([0, 1, 2], [0, 0, 1, 2]);
    expect([...numbers]).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("closes gaps left by chat-edit deletes", () => {
    const numbers = chapterNumbersByIndex([3, 0, 7], [0, 3, 7]);
    expect(numbers.get(0)).toBe(1);
    expect(numbers.get(3)).toBe(2);
    expect(numbers.get(7)).toBe(3);
  });

  it("skips chapters the UI hides because they hold no blocks", () => {
    const numbers = chapterNumbersByIndex([0, 1, 2], [0, 2]);
    expect(numbers.get(1)).toBeUndefined();
    expect(numbers.get(2)).toBe(2);
  });
});
