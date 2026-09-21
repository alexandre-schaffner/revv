import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { chatSessions } from "../db/schema";
import { ChatSessionService, ChatSessionServiceLive } from "./ChatSession";
import { DbService } from "./Db";

const SESSION_ID = "chat-session-1";
const TURN_ID = "turn-1";

function seedChatSession(db: Db): void {
  // FKs off: the session's pull-request row is irrelevant to sequencing.
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
}

function run<A>(db: Db, effect: Effect.Effect<A, never, ChatSessionService>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(ChatSessionServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

describe("listTimeline ordering", () => {
  // Regression: the chat panel rendered a turn's whole narration in one
  // block with every tool call stacked above it. A turn's prose is written
  // as one assistant row per run — sealed whenever a tool call lands — so
  // the shared sequence interleaves them in the order the agent produced
  // them. See `wrapStreamWithPersistence`.
  it("interleaves a turn's assistant runs with the activities between them", async () => {
    const db = createDb(":memory:");
    seedChatSession(db);

    const entries = await run(
      db,
      Effect.gen(function* () {
        const svc = yield* ChatSessionService;
        yield* svc.appendUserMessage({
          chatSessionId: SESSION_ID,
          turnId: TURN_ID,
          content: "fix the thing",
        });

        for (const [prose, tool] of [
          ["I'll read the file first.", "Read"],
          ["Now the patch.", "Edit"],
        ] as const) {
          const { id } = yield* svc.beginAssistantMessage({
            chatSessionId: SESSION_ID,
            turnId: TURN_ID,
          });
          yield* svc.appendAssistantContent({ messageId: id, chunk: prose });
          yield* svc.finalizeAssistantMessage({ messageId: id });
          yield* svc.appendActivity({
            chatSessionId: SESSION_ID,
            turnId: TURN_ID,
            activityKind: "tool.read",
            toolName: tool,
            summary: `${tool} ran`,
          });
        }

        const { id: last } = yield* svc.beginAssistantMessage({
          chatSessionId: SESSION_ID,
          turnId: TURN_ID,
        });
        yield* svc.appendAssistantContent({ messageId: last, chunk: "Done." });
        yield* svc.finalizeAssistantMessage({ messageId: last });

        return yield* svc.listTimeline(SESSION_ID);
      }),
    );

    expect(
      entries.map((e) =>
        e.entryKind === "message"
          ? `${e.role}: ${e.content}`
          : e.entryKind === "activity"
            ? `tool: ${e.toolName}`
            : e.entryKind,
      ),
    ).toEqual([
      "user: fix the thing",
      "assistant: I'll read the file first.",
      "tool: Read",
      "assistant: Now the patch.",
      "tool: Edit",
      "assistant: Done.",
    ]);
  });
});
