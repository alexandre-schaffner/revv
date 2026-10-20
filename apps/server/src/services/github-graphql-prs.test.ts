import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  getPrsViaGraphql,
  listClosedPrNumbersSince,
  listOpenPrsViaGraphql,
} from "./github-graphql-prs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve `pages` in order, newest first, as GitHub's cursor walk would. */
function stubPages(pages: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>): string[] {
  const asked: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { cursor: string | null };
      };
      asked.push(variables.cursor ?? "first");
      const index = variables.cursor === null ? 0 : Number(variables.cursor);
      const nodes = pages[index] ?? [];
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
                nodes,
              },
            },
          },
        }),
      );
    },
    { preconnect: realFetch.preconnect },
  );
  return asked;
}

const openNode = (number: number, updatedAt: string) => ({
  number,
  title: `PR ${number}`,
  body: "",
  isDraft: false,
  url: `https://github.test/pull/${number}`,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt,
  closedAt: null,
  headRefName: "h",
  baseRefName: "main",
  headRefOid: "a",
  baseRefOid: "b",
  author: { __typename: "User", login: "u" },
  reviewRequests: { nodes: [] },
});

describe("listOpenPrsViaGraphql with updatedSince", () => {
  it("stops at the first page that reaches older PRs and keeps only the recent ones", async () => {
    const asked = stubPages([
      [openNode(3, "2026-01-05T00:00:00Z"), openNode(2, "2026-01-04T00:00:00Z")],
      [openNode(1, "2026-01-03T00:00:00Z"), openNode(9, "2026-01-01T00:00:00Z")],
      [openNode(8, "2026-01-01T00:00:00Z")],
    ]);

    const list = await Effect.runPromise(
      listOpenPrsViaGraphql(
        "o",
        "r",
        "repo",
        "t",
        "https://ghe.test/api",
        false,
        "2026-01-03T00:00:00Z",
      ),
    );

    expect(asked).toEqual(["first", "1"]);
    expect(list.prs.map((pr) => pr.externalId)).toEqual([3, 2, 1]);
  });

  it("reads everything without it", async () => {
    const asked = stubPages([
      [openNode(2, "2026-01-04T00:00:00Z")],
      [openNode(1, "2026-01-01T00:00:00Z")],
    ]);

    const list = await Effect.runPromise(
      listOpenPrsViaGraphql("o", "r", "repo", "t", "https://ghe.test/api", false),
    );

    expect(asked).toEqual(["first", "1"]);
    expect(list.prs).toHaveLength(2);
  });
});

describe("listClosedPrNumbersSince", () => {
  it("answers the PRs closed at or after the time, reading no further than needed", async () => {
    const asked = stubPages([
      [
        { number: 7, updatedAt: "2026-01-05T00:00:00Z" },
        { number: 6, updatedAt: "2026-01-03T00:00:00Z" },
        { number: 5, updatedAt: "2026-01-02T00:00:00Z" },
      ],
      [{ number: 4, updatedAt: "2026-01-01T00:00:00Z" }],
    ]);

    const closed = await Effect.runPromise(
      listClosedPrNumbersSince("o", "r", "t", "https://ghe.test/api", "2026-01-03T00:00:00Z"),
    );

    expect(asked).toEqual(["first"]);
    expect(closed).toEqual([7, 6]);
  });

  it("answers unknown when the closures run past the pages it may read", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      number: i,
      updatedAt: "2026-01-09T00:00:00Z",
    }));
    stubPages([page, page, page, page, page, page]);

    const closed = await Effect.runPromise(
      listClosedPrNumbersSince("o", "r", "t", "https://ghe.test/api", "2026-01-03T00:00:00Z"),
    );

    expect(closed).toBeNull();
  });
});

describe("getPrsViaGraphql", () => {
  it("maps each aliased PR like the REST detail, and skips the ones GitHub couldn't resolve", async () => {
    const bodies: string[] = [];
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                p0: {
                  ...openNode(7, "2026-01-05T00:00:00Z"),
                  author: { __typename: "Bot", login: "dependabot" },
                  state: "MERGED",
                  mergedAt: "2026-01-05T00:00:00Z",
                  additions: 3,
                  deletions: 1,
                  changedFiles: 2,
                },
                p1: null,
              },
            },
            errors: [{ message: "Could not resolve to a PullRequest with the number of 8." }],
          }),
        );
      },
      { preconnect: realFetch.preconnect },
    );

    const prs = await Effect.runPromise(
      getPrsViaGraphql("o", "r", "repo-1", [7, 8], "t", "https://ghe.test/api"),
    );

    expect(bodies).toHaveLength(1);
    expect([...prs.keys()]).toEqual([7]);
    expect(prs.get(7)).toMatchObject({
      id: "repo-1:7",
      status: "merged",
      authorLogin: "dependabot[bot]",
      additions: 3,
      changedFiles: 2,
    });
  });
});
