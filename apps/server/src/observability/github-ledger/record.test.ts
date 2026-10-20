import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { githubTryPromise, newOrigin, originStore, withGitHubOrigin } from "./origin";
import { clearCalls, installGitHubLedger, isGitHubHost, readCalls, templateOf } from "./record";

describe("templateOf", () => {
  test.each([
    ["/repos/acme/web/pulls/42/files", "/repos/{owner}/{repo}/pulls/{n}/files"],
    [
      "/repos/acme/web/commits/0123456789abcdef0123456789abcdef01234567/check-runs",
      "/repos/{owner}/{repo}/commits/{sha}/check-runs",
    ],
    ["/repos/acme/web/commits/main/status", "/repos/{owner}/{repo}/commits/{ref}/status"],
    ["/repos/acme/web/contents/src/a/b.ts", "/repos/{owner}/{repo}/contents/{path}"],
    ["/repos/acme/web/compare/main...feature", "/repos/{owner}/{repo}/compare/{range}"],
    ["/repos/acme/web/git/ref/heads/feature/x", "/repos/{owner}/{repo}/git/ref/{ref}"],
    ["/users/octocat", "/users/{login}"],
    [
      "/repos/acme/web/check-runs/991/annotations",
      "/repos/{owner}/{repo}/check-runs/{n}/annotations",
    ],
  ])("%s", (path, template) => {
    expect(templateOf(path)).toBe(template);
  });
});

describe("isGitHubHost", () => {
  test.each([
    ["api.github.com", true],
    ["avatars.githubusercontent.com", true],
    ["api.nocturlab.ghe.com", true],
    ["registry.npmjs.org", false],
  ])("%s → %s", (host, expected) => {
    expect(isGitHubHost(host)).toBe(expected);
  });
});

describe("the interceptor", () => {
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    // Every GitHub answer takes a few ms and says how much budget it used.
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        await Bun.sleep(5);
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("not-modified")) return new Response(null, { status: 304 });
        return new Response('{"data":null,"errors":[{"message":"Something went wrong"}]}', {
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "4990",
            "x-ratelimit-used": "10",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1792500000",
          },
        });
      },
      { preconnect: realFetch.preconnect },
    ) as typeof fetch;
    installGitHubLedger();
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(clearCalls);

  test("records a GraphQL call: operation, rate budget, the error in its body", async () => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: "Bearer t", "If-None-Match": '"x"' },
      body: JSON.stringify({ query: "query PrConversation($n: Int!) { viewer { login } }" }),
    });
    await res.text();
    await Bun.sleep(5);
    const [call] = readCalls();
    expect(call?.op).toBe("graphql PrConversation");
    expect(call?.write).toBe(false);
    expect(call?.conditional).toBe(true);
    expect(call?.rate).toEqual({
      resource: "graphql",
      remaining: 4990,
      used: 10,
      limit: 5000,
      reset: 1792500000,
    });
    expect(call?.error).toBe("Something went wrong");
    expect(call?.durationMs).toBeGreaterThanOrEqual(5);
    expect(call?.origin.label).toBe("unattributed");
  });

  test("pages of one GraphQL read share a read key; the cursor marks them", async () => {
    const ask = (after: string | null, owner = "o") =>
      fetch("https://api.github.com/graphql", {
        method: "POST",
        body: JSON.stringify({
          query: "query OpenPullRequests($owner: String!, $after: String) { viewer { login } }",
          variables: { owner, after },
        }),
      }).then((r) => r.text());
    await ask(null);
    await ask("c1");
    await ask(null, "other");
    const [first, second, other] = readCalls();
    expect(first?.read).toBe(second?.read ?? "");
    expect(first?.key).not.toBe(second?.key ?? "");
    expect([first?.paged, second?.paged]).toEqual([false, true]);
    expect(other?.read).not.toBe(first?.read ?? "");
  });

  test("an unnamed query is named by the fields it reaches", async () => {
    await fetch("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({
        query:
          "query($owner: String!) { repository(owner: $owner, name: $n) { pullRequest(number: 1) { mergeable } } }",
      }),
    }).then((r) => r.text());
    expect(readCalls()[0]?.op).toBe("graphql {repository.pullRequest}");
  });

  test("leaves other hosts alone", async () => {
    await fetch("https://registry.npmjs.org/effect");
    expect(readCalls()).toHaveLength(0);
  });

  test("attributes each fiber's calls to its own run, across awaits and concurrency", async () => {
    // Three runs at once, each awaiting between calls: the scheduler resumes
    // them from shared callbacks, which is where an ALS-only design mixes them up.
    const run = (label: string) =>
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* Effect.sleep(1);
          yield* githubTryPromise({
            try: async () => {
              await (
                await fetch(`https://api.github.com/repos/o/r/pulls/${i}?who=${label}`)
              ).text();
              await Bun.sleep(1);
              await (await fetch(`https://api.github.com/not-modified?who=${label}`)).text();
            },
            catch: (e) => e,
          });
        }
      }).pipe(withGitHubOrigin(label));

    // Started from inside a request, the way a route would; the runs must not inherit it.
    await originStore.run(newOrigin("GET /api/x", "request"), () =>
      Effect.runPromise(Effect.all([run("a"), run("b"), run("c")], { concurrency: "unbounded" })),
    );

    const calls = readCalls();
    expect(calls).toHaveLength(18);
    for (const call of calls) {
      expect(call.url).toContain(`who=${call.origin.label}`);
    }
    const runIds = new Set(calls.map((c) => `${c.origin.label}:${c.origin.runId}`));
    expect(runIds.size).toBe(3);
  });

  test("an Effect that names no run keeps the request it was started from", async () => {
    const route = (label: string) =>
      originStore.run(newOrigin(label, "request"), () =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.sleep(2);
            yield* githubTryPromise(() =>
              fetch(`https://api.github.com/user?who=${encodeURIComponent(label)}`).then((r) =>
                r.text(),
              ),
            );
          }),
        ),
      );
    await Promise.all([route("GET /api/a"), route("GET /api/b")]);
    const calls = readCalls();
    expect(calls.map((c) => c.origin.kind)).toEqual(["request", "request"]);
    for (const call of calls) {
      expect(decodeURIComponent(call.url)).toContain(`who=${call.origin.label}`);
    }
  });
});
