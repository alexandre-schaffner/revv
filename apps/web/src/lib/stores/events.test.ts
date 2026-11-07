import { afterAll, beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import { prsStub, settingsStub, tokenStub } from "$lib/test-stubs";

const calls: string[] = [];
const hook =
  (name: string) =>
  (..._args: unknown[]): void => {
    calls.push(name);
  };

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }

  /** The connection dropped; the browser is retrying on its own. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
  }
}

const windowListeners: Array<() => void> = [];
Object.assign(globalThis, {
  EventSource: FakeEventSource,
  document: { visibilityState: "visible", addEventListener: () => {} },
  window: {
    addEventListener: (_type: string, listener: () => void) => windowListeners.push(listener),
  },
});
const focusWindow = (): void => {
  for (const listener of windowListeners) listener();
};

mock.module("$lib/api/base-url", () => ({ API_BASE_URL: "http://test" }));
mock.module("$lib/session/token.svelte", tokenStub);
mock.module("./settings.svelte", settingsStub);
mock.module("$lib/walkthrough/store.svelte", () => ({
  onEventsOpened: hook("walkthrough.open"),
  onEventsReconnected: hook("walkthrough.reconnect"),
}));
mock.module("$lib/walkthrough/sizing.svelte", () => ({}));
mock.module("$lib/hunk-scan/store.svelte", () => ({
  onEventsReconnected: hook("hunkScan.reconnect"),
}));
mock.module("$lib/recaps/store.svelte", () => ({ onEventsReconnected: hook("recaps.reconnect") }));
mock.module("./sync.svelte", () => ({
  onEventsOpened: hook("sync.open"),
  onWindowForeground: hook("sync.foreground"),
}));
mock.module("./stacks.svelte", () => ({ onEventsReconnected: hook("stacks.reconnect") }));
mock.module("./stack-headlines.svelte", () => ({
  onEventsReconnected: hook("stackHeadlines.reconnect"),
}));
mock.module("./stack-merge.svelte", () => ({ onEventsReconnected: hook("stackMerge.reconnect") }));
mock.module("./prs.svelte", () => prsStub({ rereadLists: hook("prs.reread") }));
mock.module("./repos.svelte", () => ({ rereadRepos: hook("repos.reread") }));
mock.module("./conversation.svelte", () => ({
  onEventsReconnected: hook("conversation.reconnect"),
  onWindowForeground: hook("conversation.foreground"),
}));
mock.module("./review.svelte", () => ({
  onEventsReconnected: hook("review.reconnect"),
  onWindowForeground: hook("review.foreground"),
}));
mock.module("./auth.svelte", () => ({ onEventsReconnected: hook("auth.reconnect") }));
mock.module("./merge-eligibility.svelte", () => ({}));
mock.module("./repo-activity.svelte", () => ({}));

const events = await import("./events.svelte");

let now = 1_000_000;
const advance = (ms: number): void => {
  now += ms;
  setSystemTime(new Date(now));
};

function stream(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error("no stream opened");
  return es;
}

const reconnectCatchUp = (): boolean => calls.includes("recaps.reconnect");
const foregroundReread = (): boolean => calls.includes("sync.foreground");

beforeEach(() => {
  advance(60_000);
  events.connect();
  stream().open();
  calls.length = 0;
});

afterAll(() => {
  events.disconnect();
  setSystemTime();
});

describe("catch-up after a gap", () => {
  it("a focus while the stream is reconnecting doesn't cancel the reconnect's catch-up", () => {
    advance(60_000);
    stream().drop();
    focusWindow();
    expect(foregroundReread()).toBe(true);

    advance(1_000);
    stream().open();
    expect(reconnectCatchUp()).toBe(true);
    expect(calls).toContain("auth.reconnect");
    expect(calls).toContain("hunkScan.reconnect");
  });

  it("every reconnect catches up, however close together", () => {
    advance(60_000);
    stream().drop();
    stream().open();
    calls.length = 0;
    advance(500);
    stream().drop();
    stream().open();
    expect(reconnectCatchUp()).toBe(true);
  });

  it("a focus right after a reconnect's catch-up re-reads nothing", () => {
    advance(60_000);
    stream().drop();
    stream().open();
    calls.length = 0;
    advance(1_000);
    focusWindow();
    expect(calls).toEqual([]);
  });

  it("a rapid alt-tab re-reads once", () => {
    advance(60_000);
    focusWindow();
    expect(foregroundReread()).toBe(true);
    calls.length = 0;
    advance(1_000);
    focusWindow();
    expect(calls).toEqual([]);
    advance(4_000);
    focusWindow();
    expect(foregroundReread()).toBe(true);
  });

  it("the first open is not a reconnect", () => {
    advance(60_000);
    events.connect();
    stream().open();
    expect(calls).toEqual(["walkthrough.open", "sync.open"]);
  });
});
