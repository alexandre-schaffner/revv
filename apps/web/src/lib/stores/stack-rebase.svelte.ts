// ── Stack rebase ────────────────────────────────────────────────────────────
//
// "Rebase stack": every open layer back on top of the one below it, the way
// GitHub's merge box offers it. The server runs the cascade in Revv's clone
// and pushes it in one atomic, leased push; the stack itself refreshes on the
// `stack:updated` that follows. Per-stack request state, keyed like the stack
// store, so every layer of one stack shows the same "Rebasing…".

import {
  type PrStackDetail,
  type StackLayer,
  type StackRebaseResult,
  stackKey,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
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

const isOpen = (layer: StackLayer) => layer.status !== "merged" && layer.status !== "closed";

/** Why the stack wants a rebase: its lowest open layer that's off its base. */
export type RebaseNeed =
  | { readonly kind: "behind"; readonly layer: StackLayer; readonly by: number | null }
  | { readonly kind: "conflicts"; readonly layer: StackLayer }
  | { readonly kind: "merged-below"; readonly layer: StackLayer };

export function rebaseNeed(stack: PrStackDetail): RebaseNeed | null {
  for (const layer of stack.layers) {
    if (!isOpen(layer)) continue;
    if (layer.restack.kind === "needs-rebase") return { kind: "merged-below", layer };
    if (layer.mergeStateStatus === "DIRTY") return { kind: "conflicts", layer };
    if ((layer.behindBy ?? 0) > 0) return { kind: "behind", layer, by: layer.behindBy };
    if (layer.mergeStateStatus === "BEHIND") return { kind: "behind", layer, by: null };
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
  const expectedHeads = Object.fromEntries(
    stack.layers.flatMap((l) => (isOpen(l) && l.headSha ? [[String(l.number), l.headSha]] : [])),
  );
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.rebase.post({ expectedHeads });
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
