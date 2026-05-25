import type { Activity, RecapPrEntry, RecapStreamEvent, RecapThemeSummary } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { startSpan, traced } from "$lib/observability";
import { runRecapSse } from "$lib/services/recap-sse";

// ── Entry shape ─────────────────────────────────────────────────────────────

export interface RecapStreamEntry {
  lede: string;
  /**
   * Per-PR structured entries indexed by prId so re-emits / reconnects merge
   * cleanly. Render order is `position`, ascending.
   */
  entries: Map<string, RecapPrEntry>;
  /**
   * Per-theme summary paragraphs indexed by theme label. Idempotent on the
   * server side too — `set_theme_summary` upserts on (recapId, theme).
   */
  themeSummaries: Map<string, RecapThemeSummary>;
  thoughts: string;
  phase: string;
  phaseMessage: string;
  activities: Array<Activity & { id: string }>;
  isStreaming: boolean;
  doneReceived: boolean;
  streamError: string | null;
}

export function freshEntry(): RecapStreamEntry {
  return {
    lede: "",
    entries: new Map(),
    themeSummaries: new Map(),
    thoughts: "",
    phase: "analyzing",
    phaseMessage: "Analyzing pull requests…",
    activities: [],
    isStreaming: false,
    doneReceived: false,
    streamError: null,
  };
}

// ── Reactive state ────────────────────────────────────────────────────────────

let entries = $state<Map<string, RecapStreamEntry>>(new Map());

// Abort controllers keyed by recapId.
const controllers = new Map<string, AbortController>();

// ── Getters ───────────────────────────────────────────────────────────────────

export function getRecapStreamEntry(recapId: string): RecapStreamEntry | undefined {
  return entries.get(recapId);
}

// ── Mutations ─────────────────────────────────────────────────────────────────

function setEntry(recapId: string, entry: RecapStreamEntry): void {
  const next = new Map(entries);
  next.set(recapId, entry);
  entries = next;
}

function deleteEntry(recapId: string): void {
  if (!entries.has(recapId)) return;
  const next = new Map(entries);
  next.delete(recapId);
  entries = next;
}

// ── Event reducer ───────────────────────────────────────────────────────────

function applyEvents(recapId: string, evs: RecapStreamEvent[]): void {
  traced("recap.applyEvents", { recapId, count: evs.length }, () => {
    const current = entries.get(recapId);
    const entry: RecapStreamEntry = current
      ? {
          ...current,
          entries: new Map(current.entries),
          themeSummaries: new Map(current.themeSummaries),
        }
      : freshEntry();

    for (const event of evs) {
      const span = startSpan("recap.event", { type: event.type, recapId });
      switch (event.type) {
        case "lede":
          entry.lede = event.data.lede;
          break;
        case "entry":
          entry.entries.set(event.data.entry.prId, event.data.entry);
          break;
        case "theme_summary":
          entry.themeSummaries.set(event.data.summary.theme, event.data.summary);
          break;
        case "thought":
          entry.thoughts += event.data.text;
          break;
        case "phase":
          entry.phase = event.data.phase;
          entry.phaseMessage = event.data.message;
          break;
        case "activity":
          entry.activities = [
            ...entry.activities,
            { ...normalizeRecapActivity(event.data), id: crypto.randomUUID() },
          ];
          break;
        case "done":
          entry.doneReceived = true;
          entry.isStreaming = false;
          break;
        case "error":
          entry.streamError = event.data.message;
          entry.isStreaming = false;
          break;
      }
      span.end();
    }

    setEntry(recapId, entry);
  });
}

function normalizeRecapActivity(activity: Activity): Activity {
  const toolName = normalizeRecapToolName(activity.toolName);
  if (toolName === activity.toolName && !activity.summary.startsWith("Using ")) return activity;
  return {
    ...activity,
    toolName,
    activityKind: recapActivityKind(toolName) ?? activity.activityKind,
    summary: recapActivitySummary(toolName) ?? activity.summary,
  };
}

function normalizeRecapToolName(toolName: string): string {
  const known = [
    "get_recap_state",
    "get_pr_diff",
    "list_open_prs",
    "get_repo_context",
    "set_lede",
    "add_pr_entry",
    "set_theme_summary",
    "complete_recap",
    "Bash",
  ];
  return known.find((name) => toolName === name || toolName.endsWith(`_${name}`)) ?? toolName;
}

function recapActivityKind(toolName: string): Activity["activityKind"] | null {
  if (
    toolName === "get_recap_state" ||
    toolName === "get_pr_diff" ||
    toolName === "get_repo_context"
  ) {
    return "tool.read";
  }
  if (toolName === "list_open_prs") return "tool.ls";
  if (toolName === "set_lede" || toolName === "add_pr_entry" || toolName === "set_theme_summary")
    return "tool.write";
  if (toolName === "Bash") return "tool.bash";
  return null;
}

function recapActivitySummary(toolName: string): string | null {
  switch (toolName) {
    case "get_recap_state":
      return "Reading recap state";
    case "get_pr_diff":
      return "Reading PR diff";
    case "list_open_prs":
      return "Listing open pull requests";
    case "get_repo_context":
      return "Reading prior recaps";
    case "set_lede":
      return "Writing lede";
    case "add_pr_entry":
      return "Cataloguing PR";
    case "set_theme_summary":
      return "Writing theme summary";
    case "complete_recap":
      return "Finalizing recap";
    case "Bash":
      return null;
    default:
      return null;
  }
}

// ── Stream lifecycle ─────────────────────────────────────────────────────────

export async function streamRecap(recapId: string): Promise<void> {
  // Already streaming?
  const existing = entries.get(recapId);
  if (existing?.isStreaming) return;

  abortRecapStream(recapId);

  // Reuse the existing entry only when it's in a clean "could resume"
  // state. The server's `lede` and `entry` snapshot events on connect
  // will overwrite stale data with the canonical DB state.
  const base =
    existing && !existing.doneReceived && !existing.streamError ? existing : freshEntry();
  setEntry(recapId, { ...base, isStreaming: true });

  const abortCtrl = new AbortController();
  controllers.set(recapId, abortCtrl);

  try {
    await runRecapSse({
      url: `${API_BASE_URL}/api/recaps/${recapId}/stream`,
      signal: abortCtrl.signal,
      onEvents: (events) => applyEvents(recapId, events),
    });
  } catch (e) {
    const current = entries.get(recapId);
    if (!current) return;
    if ((e as Error).name !== "AbortError") {
      setEntry(recapId, {
        ...current,
        isStreaming: false,
        streamError: e instanceof Error ? e.message : "Recap stream failed",
      });
    }
  } finally {
    const current = entries.get(recapId);
    if (current && !current.doneReceived && !current.streamError) {
      setEntry(recapId, { ...current, isStreaming: false });
    }
    controllers.delete(recapId);
  }
}

export function abortRecapStream(recapId: string): void {
  const ctrl = controllers.get(recapId);
  if (ctrl) {
    ctrl.abort();
    controllers.delete(recapId);
  }
}

export function resetRecapStream(recapId: string): void {
  abortRecapStream(recapId);
  deleteEntry(recapId);
}
