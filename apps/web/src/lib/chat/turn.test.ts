import { beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_USER_SETTINGS } from "@revv/shared";
import type { ChatCallbacks, ResolvePushCallbacks } from "$lib/api/chat";

let chatStreams: ChatCallbacks[] = [];
let resolveStreams: ResolvePushCallbacks[] = [];
let historyReads = 0;

mock.module("$lib/api/chat", () => ({
  streamChatMessage: (_params: unknown, callbacks: ChatCallbacks) => {
    chatStreams.push(callbacks);
    return new AbortController();
  },
  resolveConflictsAndPush: (_prId: string, callbacks: ResolvePushCallbacks) => {
    resolveStreams.push(callbacks);
    return new AbortController();
  },
  fetchChatMessages: async () => {
    historyReads += 1;
    return { chatSessionId: null, entries: [], interactionMode: "default" };
  },
  fetchProposedChanges: async () => ({ branchName: null, baseSha: null, commits: [] }),
  fetchSessionContext: async () => ({ commands: [], repoFiles: [] }),
  fetchAvailableAgents: async () => ({ agent: "claude", planAvailable: true }),
  approvePlan: async () => {},
  rejectPlan: async () => {},
  clearChat: async () => {},
  setInteractionMode: async () => {},
  advanceWorktree: async () => {},
  batchCherryPickProposedCommits: async () => ({ pushedCommits: 0, branch: "" }),
  batchDiscardProposedCommits: async () => ({ discardedCount: 0 }),
  cherryPickProposedCommit: async () => {},
  discardProposedCommit: async () => {},
  pushProposedChanges: async () => ({ status: "remote-changed", branch: "b" }),
  rebaseProposedCommits: async () => {},
}));
mock.module("svelte-sonner", () => ({
  toast: { error: () => {}, success: () => {}, message: () => {} },
}));
mock.module("$lib/api/client", () => ({ api: {} }));
mock.module("$lib/stores/settings.svelte", () => ({
  getSettings: () => DEFAULT_USER_SETTINGS,
}));
mock.module("$lib/stores/settingsModal.svelte", () => ({ openSettings: () => {} }));

const turn = await import("./turn.svelte");
const timeline = await import("./timeline.svelte");
const queue = await import("./queue.svelte");
const proposed = await import("./proposed.svelte");

const PR = "repo:1";
const flush = () => new Promise((r) => setTimeout(r, 0));

function lastStream(): ChatCallbacks {
  const stream = chatStreams.at(-1);
  if (!stream) throw new Error("no turn started");
  return stream;
}

beforeEach(() => {
  turn.reset();
  chatStreams = [];
  resolveStreams = [];
  historyReads = 0;
});

describe("a chat turn", () => {
  it("keeps prose and tool rows in the order the agent produced them", () => {
    turn.sendChatMessage({ prId: PR, message: " hi " });
    const stream = lastStream();
    stream.onText("Looking");
    stream.onActivity({
      activityKind: "tool.read",
      toolName: "Read",
      summary: "a.ts",
      payload: {},
    });
    stream.onText("Done");
    stream.onDone();

    const items = timeline.getChatItems(PR);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "activity", "message"]);
    expect(items[0]).toMatchObject({ role: "user", content: "hi" });
    expect(items[1]).toMatchObject({ content: "Looking", isStreaming: false });
    expect(items[3]).toMatchObject({ content: "Done", isStreaming: false });
    expect(timeline.isChatStreaming(PR)).toBe(false);
  });

  it("keeps partial text with the error when the stream fails", () => {
    turn.sendChatMessage({ prId: PR, message: "go" });
    lastStream().onText("half");
    lastStream().onError({ code: "NETWORK_ERROR", message: "Lost connection" });

    expect(timeline.getChatItems(PR).at(-1)).toMatchObject({
      content: "half",
      isStreaming: false,
      error: "Lost connection",
    });
    expect(timeline.getActiveTurnId(PR)).toBeNull();
  });

  it("queues a message sent mid-turn and sends it when the turn ends", () => {
    turn.submitChatMessage(PR, "first", []);
    turn.submitChatMessage(PR, "second", []);
    expect(chatStreams).toHaveLength(1);
    expect(queue.getQueuedMessages(PR).map((m) => m.text)).toEqual(["second"]);

    lastStream().onDone();
    expect(chatStreams).toHaveLength(2);
    expect(queue.getQueuedMessages(PR)).toEqual([]);
    expect(timeline.isChatStreaming(PR)).toBe(true);
  });

  it("stopping drops an empty bubble and frees the composer", () => {
    turn.sendChatMessage({ prId: PR, message: "go" });
    turn.abortChatTurn(PR);
    expect(timeline.getChatItems(PR).map((i) => i.kind)).toEqual(["message"]);
    expect(timeline.isChatStreaming(PR)).toBe(false);
  });
});

describe("reloading for a new head", () => {
  it("ends the turn and reads the timeline again", async () => {
    turn.openChat(PR);
    await flush();
    expect(historyReads).toBe(1);

    turn.sendChatMessage({ prId: PR, message: "go" });
    turn.reloadChatForNewHead(PR);
    await flush();

    expect(timeline.isChatStreaming(PR)).toBe(false);
    expect(historyReads).toBe(2);
  });
});

describe("resolving a conflicting push", () => {
  it("releases the resolve flag when the stream fails", async () => {
    const settled = proposed.resolveAndPushProposed(PR);
    expect(proposed.isResolvingPush(PR)).toBe(true);
    resolveStreams[0]?.onError({ code: "NETWORK_ERROR", message: "boom" });
    await settled;
    expect(proposed.isResolvingPush(PR)).toBe(false);
  });
});
