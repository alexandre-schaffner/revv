import { Effect } from "effect";
import type { GitHubError } from "../../domain/errors";
import { logError } from "../../logger";
import { type GitHubStack, layersToCompare, mapGitHubStack, withBehind } from "../stacks/map";
import { splitFullName } from "./graphql-batch";
import {
  layerCompareQuery,
  PR_STACK_QUERY,
  PR_STATE_QUERY,
  type RawLayerCompareAnswer,
  type RawPrStackAnswer,
  type RawPrState,
  STACK_SCHEMA_TOKENS,
} from "./stack-queries";
import { type GitHubClient, type GitHubHttp, withSchemaFallback } from "./transport";

export const stacksApi = (http: GitHubHttp) => {
  const withLayerBehind = (
    client: GitHubClient,
    ref: { owner: string; repo: string },
    stack: GitHubStack,
  ): Effect.Effect<GitHubStack> => {
    const layers = layersToCompare(stack);
    if (layers.length === 0) return Effect.succeed(stack);
    const { query, variables } = layerCompareQuery(layers);
    return http.graphqlPartial<RawLayerCompareAnswer>(client, query, { ...ref, ...variables }).pipe(
      Effect.map(({ data }) => withBehind(stack, data)),
      Effect.catch((err) =>
        Effect.sync(() => {
          logError("stacks", `comparing stack #${stack.number}'s layers failed`, err);
          return stack;
        }),
      ),
    );
  };

  return {
    /**
     * The stack PR `prNumber` sits in, with how far each open layer is behind
     * its base; null when it isn't stacked or the host predates stacks.
     */
    ofPr: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<GitHubStack | null, GitHubError> =>
      Effect.gen(function* () {
        const ref = yield* splitFullName(fullName);
        const { value, modern } = yield* withSchemaFallback(
          (modern) =>
            modern
              ? http.graphql<RawPrStackAnswer>(client, PR_STACK_QUERY, { ...ref, number: prNumber })
              : Effect.succeed<RawPrStackAnswer>({ repository: null }),
          STACK_SCHEMA_TOKENS,
        );
        const stack = modern ? mapGitHubStack(value, new Date().toISOString()) : null;
        return stack ? yield* withLayerBehind(client, ref, stack) : null;
      }),

    /** A PR's state (`OPEN`, `CLOSED`, `MERGED`), or null when GitHub can't see it. */
    prState: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<string | null, GitHubError> =>
      Effect.gen(function* () {
        const ref = yield* splitFullName(fullName);
        const answer = yield* http.graphql<RawPrState>(client, PR_STATE_QUERY, {
          ...ref,
          number: prNumber,
        });
        return answer.repository?.pullRequest?.state ?? null;
      }),
  };
};
