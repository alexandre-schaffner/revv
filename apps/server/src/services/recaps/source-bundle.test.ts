import { describe, expect, it } from "bun:test";
import type { ProjectRecap } from "@revv/shared";
import { Effect } from "effect";
import { createDb } from "../../db/index";
import { DbError } from "../../domain/errors";
import { makeRecapSources } from "./source-bundle";

const CLOSED_WINDOW = {
  id: "recap-1",
  repositoryId: "repo-1",
  period: "daily",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-01-02T00:00:00.000Z",
} as ProjectRecap;

describe("recap sources", () => {
  // "Nothing shipped" is final for a closed window, so only a real empty
  // window may produce it.
  it("fails on a database error instead of reading the window as empty", async () => {
    const sources = makeRecapSources({
      db: createDb(":memory:"),
      prs: {
        listArchivedPrsForWindow: () => Effect.fail(new DbError({ message: "disk I/O error" })),
        listOpenPrsAsOfWindow: () => Effect.succeed([]),
      } as never,
      prContext: { forRepo: () => Effect.fail(new DbError({ message: "unused" })) } as never,
      diffCache: {} as never,
      github: {} as never,
      mirror: {} as never,
    });

    const exit = await Effect.runPromiseExit(sources.assemble(CLOSED_WINDOW, "acme/widget"));
    expect(exit._tag).toBe("Failure");
    const silent = await Effect.runPromiseExit(sources.windowIsSilent("repo-1", CLOSED_WINDOW));
    expect(silent._tag).toBe("Failure");
  });
});
