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

const UNAVAILABLE: Record<string, string> = {
  "too-large": "File too large to preview.",
  "not-found": "File not found in this revision.",
  cloning: "Repository is still syncing.",
};

/**
 * The file at the PR's head, read from the local clone (no GitHub call).
 */
export async function loadRepoFile(prId: string, path: string): Promise<RepoFile> {
  try {
    const res = await api.api.prs({ id: prId })["repo-file"].get({ query: { path } });
    // Not-ready states arrive as error responses carrying the same body.
    const body = (res.data ?? res.error?.value) as typeof res.data;
    if (body && "status" in body) {
      if (body.status === "ready") {
        return { status: "ready", content: body.content, size: body.size };
      }
      const known = UNAVAILABLE[body.status];
      if (known) return { status: "unavailable", message: known };
      if ("message" in body && body.message)
        return { status: "unavailable", message: body.message };
    }
    return {
      status: "unavailable",
      message: res.error
        ? apiErrorMessage(res.error, "Couldn't preview file")
        : "Couldn't preview file.",
    };
  } catch (e) {
    return { status: "unavailable", message: `Couldn't load file: ${thrownMessage(e)}` };
  }
}
