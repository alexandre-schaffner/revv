import { describe, expect, test } from "bun:test";
import type { WalkthroughBlock } from "@revv/shared";
import { stepLabels } from "./steps";

function block(id: string, semanticStepIndex: number, stepIndex: number): WalkthroughBlock {
  return {
    type: "markdown",
    id,
    order: semanticStepIndex * 10000 + stepIndex,
    semanticStepIndex,
    stepIndex,
    content: id,
  };
}

describe("stepLabels", () => {
  test("numbers chapters by the steps that have blocks, steps from one", () => {
    const steps = [0, 1, 2].map((i) => ({ semanticStepIndex: i, title: `s${i}`, summary: null }));
    const labels = stepLabels(steps, [block("a", 0, 0), block("b", 2, 0), block("c", 2, 1)]);
    expect(labels.get("a")).toBe("Ch 1 · Step 1");
    expect(labels.get("b")).toBe("Ch 2 · Step 1");
    expect(labels.get("c")).toBe("Ch 2 · Step 2");
  });

  test("a block whose chapter isn't on the page has no label", () => {
    expect(stepLabels([], [block("a", 0, 0)]).has("a")).toBe(false);
  });
});
