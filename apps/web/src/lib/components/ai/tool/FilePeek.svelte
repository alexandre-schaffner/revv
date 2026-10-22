<script lang="ts">
// ── FilePeek ─────────────────────────────────────────────────────────────────
//
// Syntax-highlighted preview of the file a Read/Write/Edit tool touched. Fetches
// the file's current content from the PR's local clone via
// `GET /api/prs/:id/repo-file` (fast, rate-limit-free `git cat-file`) and renders
// it as a lightweight Pierre code block. Mounted lazily by ToolCallCard on
// expand. Falls back to the agent's captured output when the file can't be
// fetched — also rendered as a Pierre code block so the highlighting matches.
import { onMount } from "svelte";
import { API_BASE_URL } from "$lib/api/base-url";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { authHeaders } from "$lib/utils/session-token";
import CodePeek from "./CodePeek.svelte";

interface Props {
  prId: string;
  path: string;
  /** Agent-captured output, shown if the file fetch fails. */
  fallbackOutput?: string | undefined;
  /**
   * For a windowed Read (`offset`/`limit`), restrict the preview to the lines
   * actually read. `offset` is the 1-based first line; `limit` is the line
   * count, or null/undefined to read to end of file. Omit both for a full file.
   */
  offset?: number | undefined;
  limit?: number | null | undefined;
}

let { prId, path, fallbackOutput, offset, limit }: Props = $props();

// The repo-file route returns its state in the JSON body (with non-2xx HTTP
// codes for non-ready cases), so we read the body directly rather than via the
// Eden client, which would route those into its `error` channel.
interface RepoFileBody {
  status: "ready" | "cloning" | "not-found" | "too-large" | "error";
  content?: string;
  size?: number;
  message?: string;
}

type State =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "unavailable"; message: string };

let state = $state<State>({ status: "loading" });

// Resolve the windowed read into concrete (1-based start, line count) bounds for
// the peek. A windowless read (no offset/limit) renders the whole file. When
// only an offset is given, window from there to the file's end.
const startLine = $derived(offset != null && offset > 0 ? offset : 1);
const lineCount = $derived.by(() => {
  if (offset == null && (limit == null || limit <= 0)) return undefined;
  if (limit != null && limit > 0) return limit;
  if (state.status !== "ready") return undefined;
  const total = state.content.replace(/\n$/, "").split("\n").length;
  return Math.max(1, total - (startLine - 1));
});

const UNAVAILABLE: Record<string, string> = {
  "too-large": "File too large to preview.",
  "not-found": "File not found in this revision.",
  cloning: "Repository is still syncing.",
};

onMount(async () => {
  try {
    const url = `${API_BASE_URL}/api/prs/${encodeURIComponent(prId)}/repo-file?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: authHeaders() });
    const body = (await res.json()) as RepoFileBody;
    if (body.status === "ready" && typeof body.content === "string") {
      state = { status: "ready", content: body.content, size: body.size ?? body.content.length };
    } else {
      state = {
        status: "unavailable",
        message: UNAVAILABLE[body.status] ?? body.message ?? "Couldn't preview file.",
      };
    }
  } catch {
    state = { status: "unavailable", message: "Couldn't load file." };
  }
});
</script>

<div class="file-peek">
	{#if state.status === "loading"}
		<div class="file-peek-status">
			<Dotmatrix variant="square-9" size="small" />
			<span>Loading {path}…</span>
		</div>
	{:else if state.status === "ready"}
		<CodePeek path={path} content={state.content} startLine={startLine} lineCount={lineCount} />
	{:else}
		<div class="file-peek-status">{state.message}</div>
		{#if fallbackOutput}
			<CodePeek path={path} content={fallbackOutput} />
		{/if}
	{/if}
</div>

<style>
	.file-peek {
		overflow: hidden;
		border-radius: 0.375rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 50%, transparent);
	}

	.file-peek-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}
</style>
