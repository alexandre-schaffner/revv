// ── Stack rebase ────────────────────────────────────────────────────────────
//
// "Rebase stack": every open layer back on top of the one below it, the way
// GitHub's merge box offers it. The server runs the cascade in Revv's clone
// and pushes it in one atomic, leased push; the stack itself refreshes on the
// `stack:updated` that follows. Per-stack request state, keyed like the stack
// store, so every layer of one stack shows the same "Rebasing…".

import {
  isOpenLayer,
  type PrStackDetail,
  type StackLayer,
  type StackRebaseResult,
  stackKey,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { expectedHeads } from "$lib/api/wire";
import { RequestState } from "./_types";
import { refreshStack } from "./stacks.svelte";

let requests = $state(new Map<string, RequestState<StackRebaseResult>>());

function setRequest(key: string, request: RequestState<StackRebaseResult>): void {
  requests.set(key, request);
  requests = new Map(requests);
}

export function getStackRebase(stack: PrStackDetail): RequestState<StackRebaseResult> {
  return requests.get(stackKey(stack.repositoryId, stack.number)) ?? RequestState.idle();
}

/** Why the stack wants a rebase: its lowest open layer that's off its base. */
export type RebaseNeed =
  | { readonly kind: "behind"; readonly layer: StackLayer; readonly by: number | null }
  | { readonly kind: "conflicts"; readonly layer: StackLayer }
  | { readonly kind: "merged-below"; readonly layer: StackLayer };

/**
 * How a layer sits on its base, as the server's `classifyLayerMergeState`
 * reads it: DIRTY is a conflict first, then BEHIND or a compare that found
 * commits it lacks is behind. The merge driver rebases either; so does this.
 */
function offBase(layer: StackLayer): "conflicts" | "behind" | null {
  if (layer.mergeStateStatus === "DIRTY") return "conflicts";
  if (layer.mergeStateStatus === "BEHIND" || (layer.behindBy ?? 0) > 0) return "behind";
  return null;
}

export function rebaseNeed(stack: PrStackDetail): RebaseNeed | null {
  for (const layer of stack.layers) {
    if (!isOpenLayer(layer)) continue;
    if (layer.restack.kind === "needs-rebase") return { kind: "merged-below", layer };
    switch (offBase(layer)) {
      case "conflicts":
        return { kind: "conflicts", layer };
      case "behind":
        return { kind: "behind", layer, by: layer.behindBy ? layer.behindBy : null };
      case null:
        break;
    }
  }
  return null;
}

function layerCount(n: number): string {
  return `${n} ${n === 1 ? "layer" : "layers"}`;
}

/** Rebase the stack as it's shown; refuses on the server if a layer moved since. */
export async function rebaseStack(prId: string, stack: PrStackDetail): Promise<void> {
  const key = stackKey(stack.repositoryId, stack.number);
  if (requests.get(key)?.status === "loading") return;
  setRequest(key, RequestState.loading());
  try {
    const { data, error } = await api.api
      .prs({ id: prId })
      .stack.rebase.post({ expectedHeads: expectedHeads(stack.layers.filter(isOpenLayer)) });
    if (error || !data || !("rebased" in data)) {
      const message = error
        ? apiErrorMessage(error, "Couldn't rebase the stack")
        : "Unexpected response";
      setRequest(key, RequestState.error(message));
      toast.error(message);
      return;
    }
    setRequest(key, RequestState.ok(data));
    toast.success(
      data.rebased.length > 0
        ? `Rebased ${layerCount(data.rebased.length)} onto ${stack.baseRefName}`
        : "The stack already sits on its base",
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Couldn't rebase the stack";
    setRequest(key, RequestState.error(message));
    toast.error(message);
  } finally {
    void refreshStack(prId);
  }
}
