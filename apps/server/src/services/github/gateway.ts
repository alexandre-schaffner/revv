/**
 * `GitHubGateway`: every GitHub resource Revv reads or writes, organised by
 * resource. Each method takes the {@link GitHubClient} to call GitHub as —
 * the client names the host, so no call can land on another host's API.
 */
import { Context, Effect, Layer } from "effect";
import { GitHubAccounts } from "./accounts";
import { conversationApi } from "./conversation/api";
import { GitHubEtagCache } from "./etag-cache";
import { filesApi } from "./files";
import { pullsApi } from "./pulls";
import { reposApi } from "./repos";
import { reviewsApi } from "./reviews";
import { stacksApi } from "./stacks";
import { type GitHubHttp, makeHttp } from "./transport";
import { usersApi } from "./users";

const gatewayFor = (http: GitHubHttp) => ({
  prs: pullsApi(http),
  reviews: reviewsApi(http),
  repos: reposApi(http),
  files: filesApi(http),
  users: usersApi(http),
  conversation: conversationApi(http),
  stacks: stacksApi(http),
});

export type GitHubGatewayService = ReturnType<typeof gatewayFor>;

export class GitHubGateway extends Context.Service<GitHubGateway, GitHubGatewayService>()(
  "GitHubGateway",
) {}

export const GitHubGatewayLive = Layer.effect(
  GitHubGateway,
  Effect.gen(function* () {
    const etagCache = yield* GitHubEtagCache;
    const accounts = yield* GitHubAccounts;
    return gatewayFor(makeHttp(etagCache, accounts.observer));
  }),
);
