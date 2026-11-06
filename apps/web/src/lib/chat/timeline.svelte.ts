// The chat timeline of each PR: the rows the panel renders, the turn in flight
// and the session's interaction mode. Two writers fill it — the persisted
// timeline (GET /api/chat/:prId/messages) and the live turn writer.

import type { ActivityKind, ChatAttachmentMetadata, ChatTask, InteractionMode } from "@revv/shared";
import { SvelteMap } from "svelte/reactivity";
import { fetchChatMessages, type PersistedChatEntry } from "$lib/api/chat";
import { createResource } from "$lib/stores/resource";

export type ChatItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      content: string;
      isStreaming: boolean;
      attachments?: ReadonlyArray<ChatAttachmentMetadata>;
      turnId?: string;
      /** The turn failed or was stopped after this bubble had text. */
      error?: string;
    }
  | {
      kind: "activity";
      id: string;
      activityKind: ActivityKind;
      toolName: string;
      summary: string;
      turnId?: string;
      payload?: unknown;
      /** Provider tool-call id; correlates the later `activity-result` patch. */
      callId?: string;
      output?: string;
      isError?: boolean;
    }
  | {
      kind: "task-list";
      id: string;
      turnId: string;
      tasks: ReadonlyArray<ChatTask>;
    }
  | {
      kind: "plan";
      id: string;
      turnId: string;
      markdown: string;
      status: "pending" | "approved" | "rejected" | "superseded";
    };

export type ChatActivityItem = Extract<ChatItem, { kind: "activity" }>;
export type PlanStatus = Extract<ChatItem, { kind: "plan" }>["status"];

interface TimelineEntry {
  readonly items: readonly ChatItem[];
  /** The turn in flight; null when the agent is idle. */
  readonly turnId: string | null;
  readonly interactionMode: InteractionMode;
}

const IDLE: TimelineEntry = { items: [], turnId: null, interactionMode: "default" };

const entries = new SvelteMap<string, TimelineEntry>();

function entry(prId: string): TimelineEntry {
  return entries.get(prId) ?? IDLE;
}

function updateEntry(prId: string, update: (e: TimelineEntry) => TimelineEntry): void {
  entries.set(prId, update(entry(prId)));
}

function setItems(prId: string, update: (items: readonly ChatItem[]) => readonly ChatItem[]): void {
  updateEntry(prId, (e) => ({ ...e, items: update(e.items) }));
}

const history = createResource<string, null>({
  freshForMs: Number.POSITIVE_INFINITY,
  fetch: async (prId) => {
    const timeline = await fetchChatMessages(prId);
    updateEntry(prId, (e) => ({
      // A turn that started meanwhile owns the live rows.
      items: e.turnId === null ? timeline.entries.map(entryToChatItem) : e.items,
      turnId: e.turnId,
      interactionMode: timeline.interactionMode,
    }));
    return { status: "ok", data: null };
  },
});

// ── Reads ──────────────────────────────────────────────────────────────────

export function getChatItems(prId: string): readonly ChatItem[] {
  return entry(prId).items;
}

export function getActiveTurnId(prId: string): string | null {
  return entry(prId).turnId;
}

export function isChatStreaming(prId: string): boolean {
  return entry(prId).turnId !== null;
}

const NO_TASKS: ReadonlyArray<ChatTask> = [];

/** The agent's latest task list; it shows in the queue dock. */
export function getActiveTasks(prId: string): ReadonlyArray<ChatTask> {
  const list = entry(prId).items.findLast((i) => i.kind === "task-list");
  return list?.kind === "task-list" ? list.tasks : NO_TASKS;
}

export function getInteractionMode(prId: string): InteractionMode {
  return entry(prId).interactionMode;
}

// ── History ────────────────────────────────────────────────────────────────

/** Read the persisted timeline once per PR (again after `reloadChatHistory`). */
export function loadChatHistory(prId: string): void {
  void history.load(prId, prId);
}

/**
 * Re-read the persisted timeline. The rows on screen stay up until the answer
 * replaces them.
 */
export function reloadChatHistory(prId: string): void {
  history.invalidate(prId);
  loadChatHistory(prId);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function entryToChatItem(entry: PersistedChatEntry): ChatItem {
  switch (entry.entryKind) {
    case "message":
      return {
        kind: "message",
        id: entry.id,
        role: entry.role,
        content: entry.content,
        isStreaming: entry.isStreaming,
        attachments: entry.attachments,
        turnId: entry.turnId,
        ...(entry.error ? { error: entry.error } : {}),
      };
    case "activity":
      return {
        kind: "activity",
        id: entry.id,
        activityKind: entry.activityKind as ActivityKind,
        toolName: entry.toolName ?? entry.activityKind,
        summary: entry.summary,
        turnId: entry.turnId,
        ...(entry.payloadJson != null ? { payload: safeParseJson(entry.payloadJson) } : {}),
        ...(entry.callId != null ? { callId: entry.callId } : {}),
        ...(entry.output != null ? { output: entry.output } : {}),
        ...(entry.isError != null ? { isError: entry.isError } : {}),
      };
    case "task-list":
      return {
        kind: "task-list",
        id: `task-list-${entry.turnId}`,
        turnId: entry.turnId,
        tasks: entry.tasks,
      };
    case "plan":
      return {
        kind: "plan",
        id: entry.id,
        turnId: entry.turnId,
        markdown: entry.planMarkdown,
        status: entry.status,
      };
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────

export function appendItem(prId: string, item: ChatItem): void {
  setItems(prId, (items) => [...items, item]);
}

function patchItem(prId: string, id: string, patch: (item: ChatItem) => ChatItem): void {
  setItems(prId, (items) => items.map((i) => (i.id === id ? patch(i) : i)));
}

function removeItem(prId: string, id: string): void {
  setItems(prId, (items) => items.filter((i) => i.id !== id));
}

/** Mark a turn as in flight (or none). */
export function setActiveTurn(prId: string, turnId: string | null): void {
  if (entry(prId).turnId === turnId) return;
  updateEntry(prId, (e) => ({ ...e, turnId }));
}

export function setInteractionModeLocally(prId: string, mode: InteractionMode): void {
  updateEntry(prId, (e) => ({ ...e, interactionMode: mode }));
}

export function setPlanStatus(prId: string, planId: string, status: PlanStatus): void {
  patchItem(prId, planId, (item) => (item.kind === "plan" ? { ...item, status } : item));
}

/**
 * Patch the latest activity with this provider call id. Result and input
 * frames arrive during the active turn, so the most recent match is this
 * turn's row even if a provider recycles call ids across turns (the server's
 * `updateActivityResult` is turn-scoped the same way).
 */
export function patchActivity(
  prId: string,
  callId: string,
  patch: Partial<Pick<ChatActivityItem, "output" | "isError" | "payload">>,
): void {
  const items = entry(prId).items;
  const idx = items.findLastIndex((i) => i.kind === "activity" && i.callId === callId);
  const item = items[idx];
  if (item?.kind !== "activity") return;
  setItems(prId, (all) => all.with(idx, { ...item, ...patch }));
}

/**
 * A task list is a snapshot: a later one for the same turn replaces it. It
 * renders in the queue dock, not the timeline, so it doesn't close the open
 * prose bubble (the server splits persisted rows by the same rule).
 */
export function setTaskList(prId: string, turnId: string, tasks: ReadonlyArray<ChatTask>): void {
  const id = `task-list-${turnId}`;
  if (entry(prId).items.some((i) => i.id === id)) {
    patchItem(prId, id, (item) => (item.kind === "task-list" ? { ...item, tasks } : item));
  } else {
    appendItem(prId, { kind: "task-list", id, turnId, tasks });
  }
}

/**
 * Close whichever assistant bubble is still streaming: drop it if it is empty,
 * otherwise keep it with `error` as its footnote. Used when a turn is cut off
 * without the writer that opened the bubble.
 */
export function sealStreamingBubble(prId: string, error: string): void {
  const open = entry(prId).items.find(
    (i) => i.kind === "message" && i.role === "assistant" && i.isStreaming,
  );
  if (open?.kind !== "message") return;
  if (open.content.length === 0) removeItem(prId, open.id);
  else patchItem(prId, open.id, () => ({ ...open, isStreaming: false, error }));
}

export function clearTimeline(prId: string): void {
  entries.set(prId, IDLE);
  history.invalidate(prId);
}

export interface TurnWriter {
  /** Append prose to the open assistant bubble, opening one if needed. */
  text(chunk: string): void;
  /** Close the open bubble, then append `item` after it. */
  row(item: ChatItem): void;
  /**
   * Close the open bubble: drop it if empty, otherwise keep it (with `error`
   * when the turn failed, so its text and the tool rows around it survive).
   */
  seal(error?: string): void;
}

/**
 * Writes one turn in the order the agent produced it: prose opens an assistant
 * bubble lazily, any other row closes it, so the next prose run opens a fresh
 * bubble below. The server's turn journal (`services/chat/turn-journal.ts`)
 * splits the persisted rows on the same boundaries, so the live view and a
 * reload agree.
 */
export function writeTurn(prId: string, turnId: string): TurnWriter {
  let openId: string | null = null;
  return {
    text(chunk) {
      if (chunk.length === 0) return;
      if (!openId) {
        openId = crypto.randomUUID();
        appendItem(prId, {
          kind: "message",
          id: openId,
          role: "assistant",
          content: "",
          isStreaming: true,
          turnId,
        });
      }
      patchItem(prId, openId, (item) =>
        item.kind === "message" ? { ...item, content: item.content + chunk } : item,
      );
    },
    row(item) {
      this.seal();
      appendItem(prId, item);
    },
    seal(error) {
      const id = openId;
      openId = null;
      if (!id) return;
      const open = entry(prId).items.find((i) => i.id === id);
      if (open?.kind !== "message" || open.content.length === 0) {
        removeItem(prId, id);
        return;
      }
      patchItem(prId, id, () => ({ ...open, isStreaming: false, ...(error ? { error } : {}) }));
    },
  };
}

export function reset(): void {
  entries.clear();
  history.reset();
}
