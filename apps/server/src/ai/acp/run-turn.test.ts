import { describe, expect, it } from "bun:test";
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpConnectionHandle, AcpUpdateListener } from "./acp-connection";
import { AgentTurnError } from "./agent-failure";
import type { AgentLaunch } from "./agent-launch";
import { type AcpTurnRequest, makeActivityBeacon, runAcpTurn } from "./run-turn";

const launch: AgentLaunch = {
  agent: "opencode",
  model: "opencode/big-pickle",
  thinkingEffort: undefined,
};

interface FakeAgent {
  readonly handle: AcpConnectionHandle;
  readonly calls: string[];
  readonly update: (update: SessionUpdate) => void;
  readonly prompts: ContentBlock[][];
  refcount: number;
}

function fakeAgent(
  opts: {
    readonly loadSession?: "ok" | "fails" | "unsupported";
    readonly prompt?: () => Promise<"end_turn" | "refusal">;
  } = {},
): FakeAgent {
  const calls: string[] = [];
  const prompts: ContentBlock[][] = [];
  let listener: AcpUpdateListener | null = null;
  const state = { modes: null };
  const agent: FakeAgent = {
    calls,
    prompts,
    refcount: 0,
    update: (update) => listener?.(update),
    handle: {
      loadSessionSupported: opts.loadSession !== "unsupported",
      httpMcpSupported: true,
      promptImage: false,
      embeddedContext: false,
      getAvailableCommands: () => [],
      listAvailableCommands: async () => [],
      newSession: async () => {
        calls.push("newSession");
        return { sessionId: "fresh-1", ...state };
      },
      loadSession: async (id) => {
        calls.push(`loadSession:${id}`);
        if (opts.loadSession === "fails") throw new Error("Resource not found");
        return state;
      },
      setMode: async () => {},
      prompt: async (_id, blocks) => {
        prompts.push(blocks);
        return (opts.prompt ?? (async () => "end_turn" as const))();
      },
      cancel: async (id) => {
        calls.push(`cancel:${id}`);
      },
      retire: () => {
        calls.push("retire");
      },
      setListener: (_id, next) => {
        listener = next;
        calls.push(next ? "listen" : "unlisten");
      },
      setPlanMode: () => {},
      jobStarted: () => {
        agent.refcount += 1;
      },
      jobEnded: () => {
        agent.refcount -= 1;
      },
    },
  };
  return agent;
}

function turn(agent: FakeAgent, patch: Partial<AcpTurnRequest> = {}) {
  return runAcpTurn(
    {
      label: "run-turn-test",
      launch,
      cwd: "/tmp",
      prompt: (session) => [{ type: "text", text: session.fresh ? "system + message" : "message" }],
      onUpdate: () => {},
      deadlines: { ceilingMs: 5_000 },
      ...patch,
    },
    async () => agent.handle,
  );
}

const promptText = (agent: FakeAgent): string => {
  const block = agent.prompts[0]?.[0];
  return block?.type === "text" ? block.text : "";
};

describe("runAcpTurn", () => {
  it("runs a fresh session and releases the connection afterwards", async () => {
    const agent = fakeAgent();
    const opened: boolean[] = [];
    const result = await turn(agent, {
      onSessionOpened: (session) => {
        opened.push(session.fresh);
      },
    });
    expect(result.end).toEqual({ kind: "stopped", stopReason: "end_turn" });
    expect(result.session?.sessionId).toBe("fresh-1");
    expect(opened).toEqual([true]);
    expect(promptText(agent)).toBe("system + message");
    expect(agent.calls).toEqual(["newSession", "listen", "unlisten"]);
    expect(agent.refcount).toBe(0);
  });

  it("resumes a session the agent can reload, without the system prompt", async () => {
    const agent = fakeAgent({ loadSession: "ok" });
    const result = await turn(agent, { resumeSessionId: "old-1" });
    expect(result.session).toMatchObject({ sessionId: "old-1", fresh: false });
    expect(promptText(agent)).toBe("message");
  });

  it("opens a fresh session, with the system prompt, when the resume id no longer loads", async () => {
    const agent = fakeAgent({ loadSession: "fails" });
    const result = await turn(agent, { resumeSessionId: "old-1" });
    expect(agent.calls.slice(0, 2)).toEqual(["loadSession:old-1", "newSession"]);
    expect(result.session).toMatchObject({ sessionId: "fresh-1", fresh: true });
    expect(promptText(agent)).toBe("system + message");
  });

  it("treats an agent that can't reload sessions as fresh", async () => {
    const agent = fakeAgent({ loadSession: "unsupported" });
    const result = await turn(agent, { resumeSessionId: "old-1" });
    expect(result.session?.fresh).toBe(true);
    expect(promptText(agent)).toBe("system + message");
  });

  it("ends on the idle deadline by cancelling the session, retiring only an agent that ignores it", async () => {
    const agent = fakeAgent({ prompt: () => new Promise(() => {}) });
    const result = await turn(agent, { deadlines: { idleMs: 30, ceilingMs: 5_000 } });
    // The idle deadline, not the ceiling, ended it.
    expect(result.end).toMatchObject({
      kind: "timeout",
      reason: expect.stringContaining("stopped responding"),
    });
    expect(agent.calls).toContain("cancel:fresh-1");
    expect(agent.calls).not.toContain("retire");
    expect(agent.refcount).toBe(0);
    await Bun.sleep(1_700);
    expect(agent.calls).toContain("retire");
  });

  it("keeps a long turn alive while the agent keeps producing updates", async () => {
    let finish: (value: "end_turn") => void = () => {};
    const agent = fakeAgent({ prompt: () => new Promise((resolve) => (finish = resolve)) });
    const ticker = setInterval(
      () =>
        agent.update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "." },
        }),
      10,
    );
    setTimeout(() => finish("end_turn"), 150);
    try {
      const result = await turn(agent, { deadlines: { idleMs: 40, ceilingMs: 5_000 } });
      expect(result.end).toEqual({ kind: "stopped", stopReason: "end_turn" });
    } finally {
      clearInterval(ticker);
    }
  });

  it("counts the caller's activity beacon as liveness", async () => {
    let finish: (value: "end_turn") => void = () => {};
    const agent = fakeAgent({ prompt: () => new Promise((resolve) => (finish = resolve)) });
    const activity = makeActivityBeacon();
    const ticker = setInterval(() => activity.note(), 10);
    setTimeout(() => finish("end_turn"), 150);
    try {
      const result = await turn(agent, { activity, deadlines: { idleMs: 40, ceilingMs: 5_000 } });
      expect(result.end.kind).toBe("stopped");
    } finally {
      clearInterval(ticker);
    }
  });

  it("ends as cancelled when the caller aborts", async () => {
    const agent = fakeAgent({ prompt: () => new Promise(() => {}) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Stopped by user")), 20);
    const result = await turn(agent, { signal: controller.signal });
    expect(result.end).toEqual({ kind: "cancelled", reason: "Stopped by user" });
    expect(agent.calls).toContain("cancel:fresh-1");
  });

  it("rejects a failure with its kind", async () => {
    const agent = fakeAgent({
      prompt: async () => {
        throw new Error("401 Unauthorized");
      },
    });
    const error = await turn(agent).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AgentTurnError);
    expect(error).toMatchObject({ kind: "auth", agentMessage: "401 Unauthorized" });
    expect(agent.refcount).toBe(0);
  });

  it("refuses plan mode on an agent without one", async () => {
    const error = await turn(fakeAgent(), { mode: "plan" }).catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: "other" });
    expect(String(error)).toContain("no plan mode");
  });
});
