import { describe, expect, it } from "bun:test";
import type { ChatStreamFrame } from "@revv/shared";
import { type Context, Effect, Layer } from "effect";
import type { RawChatStreamFrame } from "../../ai/providers/chat-types";
import { createDb, type Db } from "../../db/index";
import { chatSessions } from "../../db/schema";
import { DbError } from "../../domain/errors";
import { ChatSessionService, ChatSessionServiceLive } from "../ChatSession";
import { DbService } from "../Db";
import { journalTurn } from "./turn-journal";

const SESSION_ID = "chat-session-1";
const TURN_ID = "turn-1";

type Sessions = Context.Service.Shape<typeof ChatSessionService>;

function sessionsOver(db: Db): Promise<Sessions> {
  const sqlite = (db as unknown as { session: { client: { run: (sql: string) => void } } }).session
    .client;
  sqlite.run("PRAGMA foreign_keys = OFF");
  db.insert(chatSessions)
    .values({
      id: SESSION_ID,
      pullRequestId: "pr-1",
      agent: "claude-code",
      model: "test-model",
      prHeadSha: "head-1",
      worktreePath: "/tmp/wt",
      branchName: "revv/pr-1",
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    })
    .run();
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ChatSessionService;
    }).pipe(
      Effect.provide(ChatSessionServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

function agentStream(
  frames: RawChatStreamFrame[],
  fail?: Error,
): ReadableStream<RawChatStreamFrame> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      if (fail) controller.error(fail);
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<ChatStreamFrame>) {
  const frames: ChatStreamFrame[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { frames, error: null };
      frames.push(value);
    }
  } catch (error) {
    return { frames, error };
  }
}

function journal(sessions: Sessions, source: ReadableStream<RawChatStreamFrame>) {
  const calls = { stopped: 0, released: 0 };
  const stream = journalTurn({
    source,
    chatSessions: sessions,
    chatSessionId: SESSION_ID,
    turnId: TURN_ID,
    prId: "pr-1",
    onProgress: () => {},
    stopAgent: () => {
      calls.stopped++;
    },
    release: Effect.sync(() => {
      calls.released++;
    }),
  });
  return { stream, calls };
}

const read = (sessions: Sessions) => Effect.runPromise(sessions.listTimeline(SESSION_ID));

const activity = (toolName: string): RawChatStreamFrame => ({
  kind: "activity",
  activityKind: "tool.read",
  toolName,
  summary: `${toolName} ran`,
  callId: `call-${toolName}`,
});

describe("journalTurn", () => {
  it("journals prose runs and tool calls in the order the agent produced them", async () => {
    const sessions = await sessionsOver(createDb(":memory:"));
    const { stream, calls } = journal(
      sessions,
      agentStream([
        { kind: "text", data: "Reading " },
        { kind: "text", data: "first." },
        activity("Read"),
        { kind: "text", data: "Done." },
      ]),
    );

    const { frames, error } = await drain(stream);
    expect(error).toBeNull();
    expect(frames.map((f) => f.kind)).toEqual(["text", "text", "activity", "text"]);
    expect(calls).toEqual({ stopped: 0, released: 1 });

    const timeline = await read(sessions);
    expect(
      timeline.map((e) =>
        e.entryKind === "message" ? `${e.content}|${e.isStreaming}` : e.entryKind,
      ),
    ).toEqual(["Reading first.|false", "activity", "Done.|false"]);
  });

  it("closes a failed turn with an assistant row carrying the error", async () => {
    const sessions = await sessionsOver(createDb(":memory:"));
    const { stream } = journal(sessions, agentStream([activity("Read")], new Error("agent died")));

    const { error } = await drain(stream);
    expect((error as Error).message).toBe("agent died");
    const timeline = await read(sessions);
    const last = timeline.at(-1);
    expect(last?.entryKind === "message" && last.error).toBe("agent died");
  });

  // Commit first, stream second: a frame whose row can't be written never
  // reaches the client, and the turn ends with the write's error instead of
  // streaming content a reload would not restore.
  it("ends the turn when a write fails, and stops the agent", async () => {
    const real = await sessionsOver(createDb(":memory:"));
    const failing: Sessions = {
      ...real,
      appendActivity: () => Effect.fail(new DbError({ message: "chat appendActivity failed" })),
    };
    const { stream, calls } = journal(
      failing,
      agentStream([{ kind: "text", data: "Reading." }, activity("Read"), activity("Edit")]),
    );

    const { frames, error } = await drain(stream);
    expect(frames.map((f) => f.kind)).toEqual(["text"]);
    expect(error).toBeInstanceOf(DbError);
    expect(calls).toEqual({ stopped: 1, released: 1 });
  });
});
