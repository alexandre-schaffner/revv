import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Either } from "effect";
import { fetchCiRollup } from "./github";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubGraphql(respond: (query: string) => unknown): string[] {
  const queries: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    queries.push(query);
    return new Response(JSON.stringify(respond(query)));
  }) as typeof fetch;
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
        Effect.either,
      ),
    );

    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain("isRequired");
    expect(Either.isRight(result) && result.right.rollup?.headSha).toBe("abc");
  });

  it("doesn't retry a rejection that names no modern field", async () => {
    const queries = stubGraphql(() => ({
      errors: [{ message: "Could not resolve to a Repository with the name 'o/r'." }],
    }));

    const result = await Effect.runPromise(
      fetchCiRollup({ owner: "o", repo: "r" }, 1, "token", "https://ghe.test/api").pipe(
        Effect.either,
      ),
    );

    expect(queries).toHaveLength(1);
    expect(Either.isLeft(result)).toBe(true);
  });
});
