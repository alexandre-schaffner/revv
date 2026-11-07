import { describe, expect, it } from "bun:test";
import { ZERO_TOKEN_USAGE } from "@revv/shared";
import { createDb, type Db } from "../../db/index";
import { commentThreads, threadMessages, walkthroughBlocks } from "../../db/schema";
import {
  anchorThreadId,
  blockId,
  blockOrder,
  decodeTokenUsage,
  type FindingIdentity,
  isJourneyChapterText,
  isSameResolvedFinding,
  issueCommentMessageId,
  issueId,
  JOURNEY_CHAPTER_KEYWORDS,
  normalizeProviderConfig,
  resolveBlockRefs,
  semanticStepId,
  upsertIssueComment,
} from "./content";

const finding: FindingIdentity = {
  severity: "warning",
  title: "Retry failures",
  description: "The request is not retried.",
  filePath: "src/request.ts",
  startLine: 12,
  endLine: 14,
};

describe("regenerated issue resolution carry-forward", () => {
  it("preserves resolution for the exact same finding", () => {
    expect(isSameResolvedFinding({ ...finding, resolutionStatus: "addressed" }, finding)).toBe(
      true,
    );
  });

  it("reopens changed or previously open findings", () => {
    expect(isSameResolvedFinding({ ...finding, resolutionStatus: "open" }, finding)).toBe(false);
    expect(
      isSameResolvedFinding(
        { ...finding, resolutionStatus: "addressed" },
        { ...finding, description: "The retry still misses timeouts." },
      ),
    ).toBe(false);
  });
});

function memoryDb(): Db {
  const db = createDb(":memory:");
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  return db;
}

async function subtleSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("deterministic identities", () => {
  // Rows already in users' databases were keyed with WebCrypto SHA-256; a
  // replay must still land on them (invariant 3).
  it("derives the ids the tools always derived", async () => {
    expect(issueId("wt", "Missing check — é", "a.ts", 3)).toBe(
      await subtleSha256("wt\0Missing check — é\0a.ts\x003"),
    );
    expect(issueId("wt", "PR-wide", null, null)).toBe(await subtleSha256("wt\0PR-wide\0\0"));
    expect(anchorThreadId("wt", "i1", "a.ts", 3, 4, "new")).toBe(
      await subtleSha256("wt\0i1\0a.ts\x003\x004\0new"),
    );
    expect(blockId("wt", 2, 1)).toBe("block-wt-2-1");
    expect(semanticStepId("wt", 2)).toBe("semantic-wt-2");
    expect(blockOrder(2, 1)).toBe(20001);
  });
});

describe("resolveBlockRefs", () => {
  it("answers with the row ids, so random ids from older imports still resolve", () => {
    const db = memoryDb();
    for (const [id, step] of [
      ["legacy-uuid", 0],
      [blockId("wt", 0, 1), 1],
    ] as const) {
      db.insert(walkthroughBlocks)
        .values({
          id,
          walkthroughId: "wt",
          semanticStepIndex: 0,
          stepIndex: step,
          order: blockOrder(0, step),
          type: "markdown",
          data: "{}",
          createdAt: "2026-01-01T00:00:00Z",
        })
        .run();
    }
    expect(
      resolveBlockRefs(db, "wt", [
        { semantic_step_index: 0, step_index: 0 },
        { semantic_step_index: 0, step_index: 1 },
        { semantic_step_index: 0, step_index: 0 },
      ]),
    ).toEqual({ blockIds: ["legacy-uuid", blockId("wt", 0, 1)] });
    expect(resolveBlockRefs(db, "wt", [{ semantic_step_index: 3, step_index: 0 }])).toEqual({
      unknown: [{ semantic_step_index: 3, step_index: 0 }],
    });
  });
});

describe("upsertIssueComment", () => {
  it("keeps one thread and one message per anchor, replacing the body on a retry", () => {
    const db = memoryDb();
    const params = {
      walkthroughId: "wt",
      prId: "pr",
      issueId: "i1",
      filePath: "a.ts",
      startLine: 3,
      endLine: 3,
      diffSide: "new" as const,
      body: "first",
    };
    const first = upsertIssueComment(db, params);
    const second = upsertIssueComment(db, { ...params, body: "second" });
    const replay = upsertIssueComment(db, { ...params, body: "second" });
    expect(second.value.thread.id).toBe(first.value.thread.id);
    expect(second.value.message.id).toBe(issueCommentMessageId(first.value.thread.id));
    expect(second.value.message.body).toBe("second");
    expect(second.value.message.editedAt).not.toBeNull();
    expect(db.select().from(commentThreads).all()).toHaveLength(1);
    expect(db.select().from(threadMessages).all()).toHaveLength(1);
    // The diff view dedupes `thread:created` by thread id, so a new body must
    // arrive as an edit; an identical replay announces nothing.
    expect(first.envelopes.map((e) => e.type)).toEqual(["thread:created"]);
    expect(second.envelopes.map((e) => e.type)).toEqual(["thread:message:edited"]);
    expect(replay.envelopes).toEqual([]);
  });
});

describe("isJourneyChapterText", () => {
  it("matches every keyword the prompt lists, and stems of them", () => {
    for (const word of Object.keys(JOURNEY_CHAPTER_KEYWORDS)) {
      expect(isJourneyChapterText(`The ${word} of this PR`, null)).toBe(true);
    }
    expect(isJourneyChapterText("Exploration first", null)).toBe(true);
    expect(isJourneyChapterText("Token validation", "Three attempt at it")).toBe(true);
    expect(isJourneyChapterText("Token validation changes", null)).toBe(false);
  });
});

describe("normalizeProviderConfig", () => {
  it("reads the driver names installs before ACP wrote as the agent that ran", () => {
    const legacy = { model: "m", thinkingEffort: null, contextWindow: "1m", maxTurns: 60 };
    expect(
      normalizeProviderConfig({ ...legacy, provider: "claude-agent-sdk" }, "m")?.provider,
    ).toBe("claude-code");
    expect(normalizeProviderConfig({ ...legacy, provider: "codex" }, "m")?.provider).toBe("codex");
    expect(normalizeProviderConfig({ ...legacy, provider: "cursor" }, "m")?.provider).toBe(
      "cursor",
    );
  });
});

describe("decodeTokenUsage", () => {
  it("fills a row from before occupancy tracking with its throughput sum", () => {
    const legacy = JSON.stringify({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 1,
    });
    expect(decodeTokenUsage(legacy)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 1,
      contextTokens: 126,
    });
  });

  it("keeps a recorded occupancy and a known window, and drops an unknown one", () => {
    const recorded = { ...ZERO_TOKEN_USAGE, inputTokens: 9, contextTokens: 3 };
    expect(decodeTokenUsage(JSON.stringify({ ...recorded, contextWindowTokens: 200 }))).toEqual({
      ...recorded,
      contextWindowTokens: 200,
    });
    expect(decodeTokenUsage(JSON.stringify({ ...recorded, contextWindowTokens: 0 }))).toEqual(
      recorded,
    );
  });

  it("reads a missing, corrupt or non-object column as zero", () => {
    for (const raw of [null, "", "{", "[1,2]", "42"]) {
      expect(decodeTokenUsage(raw)).toEqual(ZERO_TOKEN_USAGE);
    }
  });
});
