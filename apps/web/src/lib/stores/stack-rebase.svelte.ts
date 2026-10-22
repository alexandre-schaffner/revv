import {
  classifyLayerMergeState,
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

export type RebaseNeed =
  | { readonly kind: "behind"; readonly layer: StackLayer; readonly by: number | null }
  | { readonly kind: "conflicts"; readonly layer: StackLayer }
  | { readonly kind: "merged-below"; readonly layer: StackLayer };

export function rebaseNeed(stack: PrStackDetail): RebaseNeed | null {
  for (const layer of stack.layers) {
    if (!isOpenLayer(layer)) continue;
    if (layer.restack.kind === "needs-rebase") return { kind: "merged-below", layer };
    switch (classifyLayerMergeState(layer)) {
      case "conflicts":
        return { kind: "conflicts", layer };
      case "behind":
        return { kind: "behind", layer, by: layer.behindBy ? layer.behindBy : null };
      default:
        break;
    }
  }
  return null;
}

function layerCount(n: number): string {
  return `${n} ${n === 1 ? "layer" : "layers"}`;
}

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
