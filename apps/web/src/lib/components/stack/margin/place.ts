// The open PR's place in its stack, read off the stores. Called from a
// component's `$derived`, so it re-reads when the stack or its headline does.

import { getPrById } from "$lib/stores/prs.svelte";
import { getStackHeadline } from "$lib/stores/stack-headlines.svelte";
import { getStack } from "$lib/stores/stacks.svelte";
import { type StackPlace, stackPlace } from "./stack-margin";

export function readStackPlace(prId: string): StackPlace | null {
  const pr = getPrById(prId);
  if (!pr?.stack) return null;
  const stack = getStack(prId);
  if (!stack) return null;
  const headline = getStackHeadline(stack.repositoryId, stack.number)?.headline ?? null;
  return stackPlace(stack, prId, pr.externalId, headline);
}
