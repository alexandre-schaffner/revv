import { describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db";
import { account, pullRequests, repositories, reviewSessions, user } from "../db/schema";
import { DbService } from "./Db";
import { Realtime } from "./Realtime";
import { ReviewService, ReviewServiceLive } from "./Review";

const PR_ID = "repo-1:7";

function seedDb(): Db {
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  const nowDate = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      githubLogin: "alex",
      createdAt: nowDate,
      updatedAt: nowDate,
    })
    .run();
  db.insert(account)
    .values({
      id: "account-1",
      accountId: "1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: nowDate,
      updatedAt: nowDate,
    })
    .run();
  db.insert(repositories)
    .values({
      id: "repo-1",
      owner: "acme",
      name: "widgets",
      fullName: "acme/widgets",
      addedAt: now,
      accountId: "account-1",
    })
    .run();
  db.insert(pullRequests)
    .values({
      id: PR_ID,
      externalId: 7,
      repositoryId: "repo-1",
      title: "Add widgets",
      authorLogin: "alex",
      sourceBranch: "feat/widgets",
      targetBranch: "main",
      url: "https://github.com/acme/widgets/pull/7",
      createdAt: now,
      updatedAt: now,
      fetchedAt: now,
    })
    .run();
  return db;
}

function harness() {
  const db = seedDb();
  const events: Array<{ prId: string; msg: ServerEventMessage }> = [];
  const realtime = Layer.succeed(Realtime, {
    toAccount: () => Effect.void,
    toRepo: () => Effect.void,
    toPr: (prId, msg) => Effect.sync(() => void events.push({ prId, msg })),
  });
  const layer = ReviewServiceLive.pipe(
    Layer.provide(Layer.merge(realtime, Layer.succeed(DbService, { db }))),
  );
  const run = <A, E>(body: (review: ReviewService["Service"]) => Effect.Effect<A, E>): Promise<A> =>
    Effect.runPromise(Effect.flatMap(ReviewService, body).pipe(Effect.provide(layer)));
  const types = () => events.map((e) => e.msg.type);
  return { db, events, run, types };
}

const reviewer = {
  authorRole: "reviewer",
  authorName: "alex",
  authorLogin: "alex",
  messageType: "comment",
} as const;
const anchor = { filePath: "src/a.ts", startLine: 3, endLine: 4, diffSide: "new" } as const;

describe("ReviewService", () => {
  it("gives a PR one review session, however often it is asked", async () => {
    const { db, run } = harness();
    const first = await run((r) => r.sessionIdFor(PR_ID));
    expect(await run((r) => r.sessionIdFor(PR_ID))).toBe(first);
    expect(db.select().from(reviewSessions).all()).toHaveLength(1);
  });

  it("reads a PR with no threads without creating its session", async () => {
    const { db, run } = harness();
    expect(await run((r) => r.getConversation(PR_ID))).toEqual({ threads: [], messages: {} });
    expect(db.select().from(reviewSessions).all()).toHaveLength(0);
  });

  it("starts a thread with its first message and announces it on the PR", async () => {
    const { events, run } = harness();
    const { thread, message } = await run((r) =>
      r.startThread(PR_ID, anchor, { ...reviewer, body: "Rename this." }),
    );

    expect(thread.status).toBe("pending_coder");
    expect(await run((r) => r.getConversation(PR_ID))).toEqual({
      threads: [thread],
      messages: { [thread.id]: [message] },
    });
    expect(events).toEqual([
      { prId: PR_ID, msg: { type: "thread:created", data: { prId: PR_ID, thread, message } } },
    ]);
  });

  it("announces a reply, then the status it moved the thread to", async () => {
    const { run, types } = harness();
    const { thread } = await run((r) =>
      r.startThread(PR_ID, anchor, { ...reviewer, body: "Rename this." }),
    );

    const answered = await run((r) =>
      r.reply(thread.id, {
        authorRole: "coder",
        authorName: "bob",
        body: "Done.",
        messageType: "reply",
      }),
    );
    expect(answered.thread.status).toBe("pending_reviewer");
    await run((r) =>
      r.reply(thread.id, {
        authorRole: "ai_agent",
        authorName: "Revv AI",
        body: "Noted.",
        messageType: "reply",
      }),
    );

    expect(types()).toEqual([
      "thread:created",
      "thread:message",
      "thread:updated",
      "thread:message",
    ]);
  });

  // The web drops a `thread:message` for a message it already has, so an edit
  // must arrive as `thread:message:edited`.
  it("announces an edit made on GitHub as an edit", async () => {
    const { events, run } = harness();
    const { message } = await run((r) =>
      r.startThread(PR_ID, anchor, { ...reviewer, body: "Old.", externalId: "42" }),
    );

    await run((r) => r.applyRemoteEdit(message.id, "New.", "2026-11-06T00:00:00.000Z"));

    expect(events.at(-1)?.msg).toEqual({
      type: "thread:message:edited",
      data: {
        threadId: message.threadId,
        message: { ...message, body: "New.", editedAt: "2026-11-06T00:00:00.000Z" },
      },
    });
  });

  it("refuses to edit a message through another thread", async () => {
    const { run } = harness();
    const a = await run((r) => r.startThread(PR_ID, anchor, { ...reviewer, body: "A." }));
    const b = await run((r) => r.startThread(PR_ID, anchor, { ...reviewer, body: "B." }));

    const refused = await run((r) =>
      r.editDraft(a.thread.id, b.message.id, "Hijacked.", "alex").pipe(Effect.flip),
    );
    expect(refused._tag).toBe("NotFoundError");
  });

  it("folds a thread's posted drafts into the one GitHub comment", async () => {
    const { run } = harness();
    const { thread, message } = await run((r) =>
      r.startThread(PR_ID, anchor, { ...reviewer, body: "First." }),
    );
    const { message: second } = await run((r) =>
      r.reply(thread.id, { ...reviewer, body: "Second.", messageType: "reply" }),
    );

    await run((r) =>
      r.linkPostedDrafts(thread.id, [message.id, second.id], "900", "First.\n\nSecond."),
    );

    const after = await run((r) => r.getConversation(PR_ID));
    expect(after.threads[0]?.externalCommentId).toBe("900");
    expect(after.messages[thread.id]?.map((m) => [m.id, m.body, m.externalId])).toEqual([
      [message.id, "First.\n\nSecond.", "900"],
    ]);
  });

  it("keeps a status set in Revv over GitHub's until it is pushed", async () => {
    const { run, types } = harness();
    const onGitHub = { ...anchor, externalCommentId: "42" };
    const { thread } = await run((r) =>
      r.startThread(PR_ID, onGitHub, { ...reviewer, body: "Rename this.", externalId: "42" }),
    );
    await run((r) => r.setStatus(thread.id, "resolved"));
    const announced = types().length;

    expect(await run((r) => r.applyRemoteResolved(thread.id, false))).toBe("pending");
    expect((await run((r) => r.getThread(thread.id))).thread.status).toBe("resolved");
    expect(types()).toHaveLength(announced);

    // GitHub took an older status: the newer one stays pending.
    await run((r) => r.statusPushed(thread.id, "open"));
    expect(await run((r) => r.applyRemoteResolved(thread.id, false))).toBe("pending");

    await run((r) => r.statusPushed(thread.id, "resolved"));
    expect(await run((r) => r.applyRemoteResolved(thread.id, false))).toBe("changed");
    expect((await run((r) => r.getThread(thread.id))).thread.status).toBe("open");
    expect(types().at(-1)).toBe("thread:updated");
  });

  it("clears the pending status once GitHub agrees with it", async () => {
    const { run } = harness();
    const onGitHub = { ...anchor, externalCommentId: "42" };
    const { thread } = await run((r) =>
      r.startThread(PR_ID, onGitHub, { ...reviewer, body: "Rename this.", externalId: "42" }),
    );
    await run((r) => r.setStatus(thread.id, "wont_fix"));

    expect(await run((r) => r.applyRemoteResolved(thread.id, true))).toBe("unchanged");
    expect(await run((r) => r.applyRemoteResolved(thread.id, false))).toBe("changed");
  });

  it("lets GitHub's status win on a thread with nothing to push", async () => {
    const { run } = harness();
    const { thread } = await run((r) =>
      r.startThread(PR_ID, anchor, { ...reviewer, body: "Local only." }),
    );
    await run((r) => r.setStatus(thread.id, "resolved"));

    expect(await run((r) => r.applyRemoteResolved(thread.id, false))).toBe("changed");
  });
});
