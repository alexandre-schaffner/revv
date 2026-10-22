import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Result } from "effect";
import { fetchCheckDetails, fetchCiRollup, fetchConversation } from "./github";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubGraphql(
  respond: (query: string, variables: Record<string, unknown>) => unknown,
): string[] {
  const queries: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      queries.push(query);
      return new Response(JSON.stringify(respond(query, variables)));
    },
    { preconnect: realFetch.preconnect },
  );
  return queries;
}

const ROLLUP = {
  repository: {
    pullRequest: {
      commits: { nodes: [{ commit: { oid: "abc", statusCheckRollup: null } }] },
    },
  },
};

describe("legacy GitHub Enterprise fallback", () => {
  // A query naming an unknown field comes back with `errors` and no `data`
  // at all; the fallback has to see GitHub's message to know to retry.
  it("re-asks without the modern fields when GraphQL rejects one", async () => {
    const queries = stubGraphql((query) =>
      query.includes("isRequired")
        ? { errors: [{ message: "Field 'isRequired' doesn't exist on type 'CheckRun'" }] }
        : { data: ROLLUP },
    );

    const result = await Effect.runPromise(
      fetchCiRollup({ owner: "o", repo: "r" }, 1, "token", "https://ghe.test/api").pipe(
        Effect.result,
      ),
    );

    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain("isRequired");
    expect(Result.isSuccess(result) && result.success.rollup?.headSha).toBe("abc");
  });

  it("doesn't retry a rejection that names no modern field", async () => {
    const queries = stubGraphql(() => ({
      errors: [{ message: "Could not resolve to a Repository with the name 'o/r'." }],
    }));

    const result = await Effect.runPromise(
      fetchCiRollup({ owner: "o", repo: "r" }, 1, "token", "https://ghe.test/api").pipe(
        Effect.result,
      ),
    );

    expect(queries).toHaveLength(1);
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("complete CI context lists", () => {
  function check(id: number, conclusion = "SUCCESS") {
    return {
      __typename: "CheckRun",
      databaseId: id,
      name: `check-${id}`,
      status: "COMPLETED",
      conclusion,
    };
  }

  function firstPage() {
    return {
      oid: "original-head",
      statusCheckRollup: {
        state: "FAILURE",
        contexts: {
          nodes: Array.from({ length: 100 }, (_, i) => check(i + 1)),
          pageInfo: { hasNextPage: true, endCursor: "after-100" },
        },
      },
    };
  }

  function respond(query: string, variables: Record<string, unknown>) {
    if (query.includes("query PrCheckContexts")) {
      expect(variables.sha).toBe("original-head");
      expect(variables.checkCursor).toBe("after-100");
      return {
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    check(101, "FAILURE"),
                    {
                      __typename: "CheckRun",
                      databaseId: 102,
                      name: "pending",
                      status: "IN_PROGRESS",
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: "end" },
                },
              },
            },
          },
        },
      };
    }
    return {
      data: {
        viewer: { login: "viewer" },
        repository: {
          viewerPermission: "WRITE",
          pullRequest: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            body: "",
            createdAt: "2026-01-01T00:00:00Z",
            state: "OPEN",
            isDraft: false,
            reviewDecision: null,
            viewerCanUpdate: true,
            author: { login: "author", __typename: "User" },
            labels: { nodes: [] },
            assignees: { nodes: [] },
            participants: { nodes: [] },
            reviewRequests: { nodes: [] },
            timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
            commits: { nodes: [{ commit: firstPage() }] },
          },
        },
      },
    };
  }

  it("includes failing and pending checks after the first 100 when polling", async () => {
    const queries = stubGraphql(respond);
    const { rollup } = await Effect.runPromise(
      fetchCiRollup({ owner: "o", repo: "r" }, 1, "token", "https://ghe.test/api"),
    );
    expect(queries).toHaveLength(2);
    expect(rollup?.checks).toHaveLength(102);
    expect(rollup?.checks.at(-2)?.bucket).toBe("fail");
    expect(rollup?.checks.at(-1)?.bucket).toBe("pending");
  });

  it("includes the same follow-up checks in a full conversation", async () => {
    const queries = stubGraphql(respond);
    const { conversation } = await Effect.runPromise(
      fetchConversation({ owner: "o", repo: "r" }, 1, "pr-id", "token", "https://ghe.test/api"),
    );
    expect(queries).toHaveLength(2);
    expect(conversation.ci?.checks).toHaveLength(102);
    expect(conversation.ci?.checks.at(-2)?.bucket).toBe("fail");
  });

  it("keeps the legacy schema for later pages", async () => {
    const queries = stubGraphql((query, variables) =>
      query.includes("isRequired")
        ? { errors: [{ message: "Field 'isRequired' doesn't exist on type 'CheckRun'" }] }
        : respond(query, variables),
    );
    const { rollup } = await Effect.runPromise(
      fetchCiRollup({ owner: "o", repo: "r" }, 1, "token", "https://ghe.test/api"),
    );
    expect(queries).toHaveLength(3);
    expect(queries[2]).not.toContain("isRequired");
    expect(queries[2]).not.toContain("$number");
    expect(rollup?.checks).toHaveLength(102);
  });
});

describe("third-party check completion", () => {
  it("keeps unfinished output refreshable even when the app never provides Actions logs", async () => {
    let completed = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).includes("/annotations")
              ? completed
                ? [
                    {
                      path: "a.ts",
                      start_line: 1,
                      end_line: 1,
                      annotation_level: "failure",
                      title: null,
                      message: "failed",
                    },
                  ]
                : []
              : {
                  status: completed ? "completed" : "in_progress",
                  app: { slug: "third-party-ci" },
                  output: { title: "CI", summary: completed ? "Final failure" : "Starting" },
                },
          ),
        ),
      { preconnect: realFetch.preconnect },
    );
    const run = () =>
      Effect.runPromise(
        fetchCheckDetails({ owner: "o", repo: "r" }, 123, "token", "https://ghe.test/api"),
      );
    const running = await run();
    expect(running.completed).toBe(false);
    expect(running.logUnavailable).toBe("not_actions");
    completed = true;
    const final = await run();
    expect(final.completed).toBe(true);
    expect(final.summary).toBe("Final failure");
    expect(final.annotations).toHaveLength(1);
  });
});

// GitHub answers a query that timed out or broke on its side with a 200 and
// this message; it is not a verdict on the query, so it earns a retry.
describe("GitHub's own GraphQL failures", () => {
  const FAILURE = {
    data: null,
    errors: [
      {
        message:
          "Something went wrong while executing your query on 2026-10-16T07:32:34Z. Please include `FAAB:231FE:2E4231:A23109:6AD1D30F` when reporting this issue.",
      },
    ],
  };

  const CONVERSATION = {
    data: {
      viewer: { login: "viewer" },
      repository: {
        viewerPermission: "WRITE",
        pullRequest: {
          number: 1,
          url: "https://github.com/o/r/pull/1",
          body: "",
          createdAt: "2026-01-01T00:00:00Z",
          state: "OPEN",
          isDraft: false,
          reviewDecision: null,
          viewerCanUpdate: true,
          author: { login: "author", __typename: "User" },
          labels: { nodes: [] },
          assignees: { nodes: [] },
          participants: { nodes: [] },
          reviewRequests: { nodes: [] },
          timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
          commits: { nodes: [] },
        },
      },
    },
  };

  it("asks the conversation again instead of failing the tab", async () => {
    const queries = stubGraphql(() => (queries.length === 1 ? FAILURE : CONVERSATION));

    const result = await Effect.runPromise(
      fetchConversation(
        { owner: "o", repo: "r" },
        1,
        "pr-id",
        "token",
        "https://ghe.test/api",
      ).pipe(Effect.result),
    );

    expect(queries).toHaveLength(2);
    expect(Result.isSuccess(result) && result.success.conversation.number).toBe(1);
  });
});
