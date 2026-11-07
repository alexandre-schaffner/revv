import { Effect } from "effect";
import type { GitHubError } from "../../domain/errors";
import { splitFullName } from "./graphql-batch";
import { type GitHubClient, type GitHubHttp, retryTransient } from "./transport";

const contentsPath = (owner: string, repo: string, path: string, ref: string) =>
  `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`;

export const filesApi = (http: GitHubHttp) => ({
  /** A text file's content; "" for a binary file or an unsupported encoding. */
  content: (
    client: GitHubClient,
    fullName: string,
    path: string,
    ref: string,
  ): Effect.Effect<string, GitHubError> =>
    Effect.gen(function* () {
      const { owner, repo } = yield* splitFullName(fullName);
      const obj = (yield* http.json(client, {
        path: contentsPath(owner, repo, path, ref),
      })) as Record<string, unknown>;
      if (obj.encoding === "base64" && typeof obj.content === "string") {
        return Buffer.from(obj.content, "base64").toString("utf-8");
      }
      return "";
    }).pipe(retryTransient),

  /**
   * A file's raw bytes at a ref. `application/vnd.github.raw` makes GitHub
   * send the blob itself instead of a base64 JSON envelope — needed for
   * binary files the local shallow clone may not have yet.
   */
  rawBytes: (
    client: GitHubClient,
    fullName: string,
    path: string,
    ref: string,
  ): Effect.Effect<Uint8Array, GitHubError> =>
    Effect.gen(function* () {
      const { owner, repo } = yield* splitFullName(fullName);
      return yield* http.bytes(client, {
        path: contentsPath(owner, repo, path, ref),
        accept: "application/vnd.github.raw",
      });
    }).pipe(retryTransient),
});
