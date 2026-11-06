// Messages the user sent while the agent was mid-turn, per PR. They exist only
// in this window; the turn module sends the next one when a turn ends.

import type { ChatAttachment } from "@revv/shared";
import { SvelteMap } from "svelte/reactivity";

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

const NONE: readonly QueuedMessage[] = [];
const queues = new SvelteMap<string, readonly QueuedMessage[]>();

function setQueue(prId: string, queue: readonly QueuedMessage[]): void {
  if (queue.length === 0) queues.delete(prId);
  else queues.set(prId, queue);
}

export function getQueuedMessages(prId: string): readonly QueuedMessage[] {
  return queues.get(prId) ?? NONE;
}

export function queueMessage(
  prId: string,
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
): void {
  setQueue(prId, [...getQueuedMessages(prId), { id: crypto.randomUUID(), text, attachments }]);
}

export function removeQueuedMessage(prId: string, messageId: string): void {
  setQueue(
    prId,
    getQueuedMessages(prId).filter((m) => m.id !== messageId),
  );
}

export function takeQueuedMessage(prId: string): QueuedMessage | null {
  const [next, ...rest] = getQueuedMessages(prId);
  if (!next) return null;
  setQueue(prId, rest);
  return next;
}

export function clearQueuedMessages(prId: string): void {
  queues.delete(prId);
}

export function reset(): void {
  queues.clear();
}
