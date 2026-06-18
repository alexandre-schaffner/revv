import { describe, expect, it } from "bun:test";
import { GitHubAuthError, GitHubRateLimitError } from "../domain/errors";
import {
  type CachedDiffFile,
  hasCompleteCachedFiles,
  shouldServeCachedFilesOnFetchError,
} from "./DiffCache";
import { PR_FILES_MAX_COUNT } from "./GitHub";

function cachedFile(path: string): CachedDiffFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("hasCompleteCachedFiles", () => {
  it("accepts cached files when no expected count is available", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")])).toBe(true);
  });

  it("rejects cached files below the PR changed-files count", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")], 2)).toBe(false);
  });

  it("caps the expected count to the GitHub files endpoint range", () => {
    const files = Array.from({ length: PR_FILES_MAX_COUNT }, (_, i) => cachedFile(`src/${i}.ts`));
    expect(hasCompleteCachedFiles(files, PR_FILES_MAX_COUNT + 1)).toBe(true);
  });
});

describe("shouldServeCachedFilesOnFetchError", () => {
  it("serves existing cached files when GitHub rate-limits the refresh", () => {
    const cached = [cachedFile("src/a.ts")];
    const error = new GitHubRateLimitError({
      resetAt: new Date("2026-01-01T00:01:00.000Z"),
      kind: "primary",
    });

    expect(shouldServeCachedFilesOnFetchError(cached, error)).toBe(true);
  });

  it("does not mask rate limits when there is no cache to render", () => {
    const error = new GitHubRateLimitError({
      resetAt: new Date("2026-01-01T00:01:00.000Z"),
      kind: "primary",
    });

    expect(shouldServeCachedFilesOnFetchError(null, error)).toBe(false);
  });

  it("does not serve cached files for non-rate-limit GitHub errors", () => {
    const cached = [cachedFile("src/a.ts")];
    const error = new GitHubAuthError({ message: "Invalid or expired GitHub token" });

    expect(shouldServeCachedFilesOnFetchError(cached, error)).toBe(false);
  });
});
