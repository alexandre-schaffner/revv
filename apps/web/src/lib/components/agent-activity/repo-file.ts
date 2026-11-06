// File peeks show a file from the PR's local clone. The surface rendering
// agent activity (the chat panel, the walkthrough) names that PR once with
// `provideActivityPr`, so the cards in between don't carry it.

import { getContext, setContext } from "svelte";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";

const ACTIVITY_PR = Symbol("agent-activity-pr");

export function provideActivityPr(prId: () => string | null): void {
  setContext(ACTIVITY_PR, prId);
}

export function getActivityPr(): string | null {
  return getContext<(() => string | null) | undefined>(ACTIVITY_PR)?.() ?? null;
}

export type RepoFile =
  | { readonly status: "ready"; readonly content: string; readonly size: number }
  | { readonly status: "unavailable"; readonly message: string };

const UNAVAILABLE = {
  "too-large": "File too large to preview.",
  "not-found": "File not found in this revision.",
  cloning: "Repository is still syncing.",
} as const;

/**
 * The file at the PR's head, read from the local clone (no GitHub call).
 */
export async function loadRepoFile(prId: string, path: string): Promise<RepoFile> {
  try {
    const { data, error } = await api.api.prs({ id: prId })["repo-file"].get({ query: { path } });
    if (error) {
      return { status: "unavailable", message: apiErrorMessage(error, "Couldn't preview file") };
    }
    if (data.status === "ready") {
      return { status: "ready", content: data.content, size: data.size };
    }
    return {
      status: "unavailable",
      message:
        data.status === "error"
          ? data.message || "Couldn't preview file."
          : UNAVAILABLE[data.status],
    };
  } catch (e) {
    return { status: "unavailable", message: `Couldn't load file: ${thrownMessage(e)}` };
  }
}
