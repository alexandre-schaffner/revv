// Where a block sits in the walkthrough as the reader sees it: "Ch 2 · Step 3".
// Chapters are numbered by the same rule the chat agent reads them by.

import {
  chapterNumbersByIndex,
  type WalkthroughBlock,
  type WalkthroughSemanticStep,
} from "@revv/shared";

/** The printed chapter number of each semantic step that has blocks. */
export function chapterNumbers(
  steps: readonly WalkthroughSemanticStep[],
  blocks: readonly WalkthroughBlock[],
): Map<number, number> {
  return chapterNumbersByIndex(
    steps.map((s) => s.semanticStepIndex),
    blocks.map((b) => b.semanticStepIndex),
  );
}

/** "Ch N · Step M" for each block in a numbered chapter. */
export function stepLabels(
  steps: readonly WalkthroughSemanticStep[],
  blocks: readonly WalkthroughBlock[],
): Map<string, string> {
  const numbers = chapterNumbers(steps, blocks);
  const labels = new Map<string, string>();
  for (const block of blocks) {
    const chapter = numbers.get(block.semanticStepIndex);
    if (chapter !== undefined) labels.set(block.id, `Ch ${chapter} · Step ${block.stepIndex + 1}`);
  }
  return labels;
}
