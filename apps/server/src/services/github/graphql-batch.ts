// Many PRs of one repo, or many repos, in one GraphQL request: one aliased
// field per item. GitHub answers an alias it can't resolve (PR deleted, repo
// renamed, access revoked) with `null` plus an `errors` entry, which must not
// cost the other aliases theirs; such an item is absent from the result, which
// callers read as "unknown", never as "none".
import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../../domain/errors";
import type { GitHubClient, GitHubHttp } from "./transport";

/** Split `owner/repo`, failing as not found when it isn't one. */
export function splitFullName(
  fullName: string,
): Effect.Effect<{ owner: string; repo: string }, GitHubNotFoundError> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    return Effect.fail(new GitHubNotFoundError({ resource: "repo", id: fullName }));
  }
  return Effect.succeed({ owner, repo });
}

export function prsByNumber<N>(
  http: GitHubHttp,
  client: GitHubClient,
  operation: string,
  fullName: string,
  numbers: readonly number[],
  selection: string,
  chunkSize: number,
): Effect.Effect<Map<number, N>, GitHubError> {
  return Effect.gen(function* () {
    const { owner, repo } = yield* splitFullName(fullName);
    const result = new Map<number, N>();
    for (let start = 0; start < numbers.length; start += chunkSize) {
      const chunk = numbers.slice(start, start + chunkSize);
      const argDefs = chunk.map((_, i) => `$n${i}: Int!`).join(", ");
      const fields = chunk
        .map((_, i) => `p${i}: pullRequest(number: $n${i}) { ${selection} }`)
        .join("\n");
      const variables: Record<string, string | number> = { owner, name: repo };
      chunk.forEach((n, i) => {
        variables[`n${i}`] = n;
      });
      const { data } = yield* http.graphqlPartial<{
        repository: Record<string, N | null> | null;
      }>(
        client,
        `query ${operation}($owner: String!, $name: String!, ${argDefs}) {
  repository(owner: $owner, name: $name) {
${fields}
  }
}`,
        variables,
      );
      chunk.forEach((n, i) => {
        const node = data.repository?.[`p${i}`];
        if (node) result.set(n, node);
      });
    }
    return result;
  });
}

/**
 * Comfortably inside GitHub's per-query node limit (each alias asks for one
 * node), and small enough that the request body stays modest on GHE.
 */
const REPO_CHUNK_SIZE = 80;

export function reposByName<N>(
  http: GitHubHttp,
  client: GitHubClient,
  operation: string,
  fullNames: readonly string[],
  selection: string,
): Effect.Effect<Map<string, N>, GitHubError> {
  return Effect.gen(function* () {
    const result = new Map<string, N>();
    for (let start = 0; start < fullNames.length; start += REPO_CHUNK_SIZE) {
      const chunk = fullNames.slice(start, start + REPO_CHUNK_SIZE);
      const argDefs: string[] = [];
      const fields: string[] = [];
      const variables: Record<string, string> = {};
      chunk.forEach((fullName, i) => {
        const [owner, name] = fullName.split("/");
        if (!owner || !name) return;
        argDefs.push(`$o${i}: String!, $n${i}: String!`);
        fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ${selection} }`);
        variables[`o${i}`] = owner;
        variables[`n${i}`] = name;
      });
      if (fields.length === 0) continue;
      const { data } = yield* http.graphqlPartial<Record<string, N | null>>(
        client,
        `query ${operation}(${argDefs.join(", ")}) {\n${fields.join("\n")}\n}`,
        variables,
      );
      chunk.forEach((fullName, i) => {
        const node = data[`r${i}`];
        if (node) result.set(fullName, node);
      });
    }
    return result;
  });
}
