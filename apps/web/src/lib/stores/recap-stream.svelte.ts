import type { RecapStreamEvent } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { runRecapSse } from "$lib/services/recap-sse";

// ── Entry shape ─────────────────────────────────────────────────────────────

export interface RecapStreamEntry {
  overview: string;
  phase: string;
  phaseMessage: string;
  isStreaming: boolean;
  doneReceived: boolean;
  streamError: string | null;
}

export function freshEntry(): RecapStreamEntry {
  return {
    overview: "",
    phase: "analyzing",
    phaseMessage: "Analyzing pull requests…",
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
  const current = entries.get(recapId);
  const entry = current ? { ...current } : freshEntry();

  for (const event of evs) {
    switch (event.type) {
      case "chunk":
        entry.overview += event.data.text;
        break;
      case "phase":
        entry.phase = event.data.phase;
        entry.phaseMessage = event.data.message;
        break;
      case "overview":
        entry.overview = event.data.overview;
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
  }

  setEntry(recapId, entry);
}

// ── Stream lifecycle ─────────────────────────────────────────────────────────

export async function streamRecap(recapId: string): Promise<void> {
  // Already streaming?
  const existing = entries.get(recapId);
  if (existing?.isStreaming) return;

  abortRecapStream(recapId);

  // Reuse the existing entry only when it's in a clean "could resume"
  // state. The server's `overview` snapshot event will overwrite any
  // stale overview text, so reuse is safe — it just preserves the
  // phase label so the UI doesn't flash "Analyzing…" on reconnect.
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

export function resetAllRecapStreams(): void {
  for (const [recapId] of controllers) {
    abortRecapStream(recapId);
  }
  entries = new Map();
}
