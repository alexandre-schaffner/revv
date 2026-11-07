import type {
  Activity,
  ProjectRecap,
  RecapPrEntry,
  RecapStreamEvent,
  RecapStreamPhase,
  RecapThemeSummary,
} from "@revv/shared";
import { sseErrorMessage, streamSse } from "$lib/api/sse-stream";

export interface RecapStreamEntry {
  lede: string;
  /** Keyed by prId so re-emits on reconnect merge; render in `position` order. */
  entries: Map<string, RecapPrEntry>;
  themeSummaries: Map<string, RecapThemeSummary>;
  thoughts: string;
  phase: RecapStreamPhase;
  phaseMessage: string;
  activities: Array<Activity & { id: string }>;
  isStreaming: boolean;
  doneReceived: boolean;
  /** The server reported the run stopped by the user. */
  stopped: boolean;
  streamError: string | null;
}

export function recapStreamEnded(entry: RecapStreamEntry | undefined): boolean {
  return !!entry && (entry.doneReceived || entry.stopped || entry.streamError !== null);
}

export function mergeRecapStream(
  recap: ProjectRecap,
  stream: RecapStreamEntry | undefined,
): ProjectRecap {
  if (!stream) return recap;
  const entries = new Map(recap.entries.map((e) => [e.prId, e]));
  for (const [prId, entry] of stream.entries) entries.set(prId, entry);
  const summaries = new Map(recap.themeSummaries.map((s) => [s.theme, s]));
  for (const [theme, summary] of stream.themeSummaries) summaries.set(theme, summary);
  return {
    ...recap,
    lede: stream.lede || recap.lede,
    entries: [...entries.values()].sort((a, b) => a.position - b.position),
    themeSummaries: [...summaries.values()],
  };
}

function freshEntry(): RecapStreamEntry {
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
    stopped: false,
    streamError: null,
  };
}

let entries = $state<Map<string, RecapStreamEntry>>(new Map());

const controllers = new Map<string, AbortController>();

export function getRecapStreamEntry(recapId: string): RecapStreamEntry | undefined {
  return entries.get(recapId);
}

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

function applyEvents(recapId: string, evs: RecapStreamEvent[]): void {
  const current = entries.get(recapId);
  let entry: RecapStreamEntry = current
    ? {
        ...current,
        entries: new Map(current.entries),
        themeSummaries: new Map(current.themeSummaries),
      }
    : freshEntry();

  for (const event of evs) {
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
        entry.activities = [...entry.activities, { ...event.data, id: crypto.randomUUID() }];
        break;
      case "done":
        entry.doneReceived = true;
        entry.isStreaming = false;
        break;
      case "stopped":
        entry.stopped = true;
        entry.isStreaming = false;
        break;
      case "error":
        entry.streamError = event.data.message;
        entry.isStreaming = false;
        break;
      // The server reset the row for a rerun: what this run streamed is gone.
      case "restarted":
        entry = freshEntry();
        break;
    }
  }

  setEntry(recapId, entry);
}

export async function streamRecap(recapId: string): Promise<void> {
  const existing = entries.get(recapId);
  if (existing?.isStreaming) return;

  abortRecapStream(recapId);

  // The server replays `lede` and `entry` snapshots from the DB on connect,
  // overwriting whatever a resumable entry still holds.
  const base = existing && !recapStreamEnded(existing) ? existing : freshEntry();
  setEntry(recapId, { ...base, isStreaming: true });

  const abortCtrl = new AbortController();
  controllers.set(recapId, abortCtrl);
  let restarted = false;

  try {
    await streamSse<RecapStreamEvent>({
      path: `/api/recaps/${recapId}/stream`,
      signal: abortCtrl.signal,
      onEvent: (event) => {
        if (event.type === "restarted") restarted = true;
        applyEvents(recapId, [event]);
      },
    });
  } catch (e) {
    const current = entries.get(recapId);
    if (!current) return;
    const message = sseErrorMessage(e, "The recap stream was refused");
    if (message !== null)
      setEntry(recapId, { ...current, isStreaming: false, streamError: message });
  } finally {
    const current = entries.get(recapId);
    if (current && !recapStreamEnded(current)) {
      setEntry(recapId, { ...current, isStreaming: false });
    }
    controllers.delete(recapId);
  }
  // The rerun runs under the same id: follow it on a new stream.
  if (restarted && !abortCtrl.signal.aborted) void streamRecap(recapId);
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

export function reset(): void {
  for (const ctrl of controllers.values()) ctrl.abort();
  controllers.clear();
  entries = new Map();
}
