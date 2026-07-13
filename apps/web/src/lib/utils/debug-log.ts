// ── Renderer diagnostic log ──────────────────────────────────────────────────
//
// Ships breadcrumbs and uncaught errors from the (freeze-prone) renderer to the
// local server, which appends them to `<appDataDir>/revv-debug.log`. This
// survives a hard renderer freeze + app kill in a way the DevTools console does
// not — the file is on disk and can be read after the fact.
//
// Enabled automatically under `import.meta.env.DEV` (i.e. `make dev`), or in a
// packaged build via `localStorage.setItem("revv:debug-log", "1")`. When
// disabled every entry point is a cheap no-op.
//
// Flush strategy: breadcrumbs buffer and flush on a short timer, so an ASYNC
// runaway loop (which yields between iterations) produces a steadily-growing
// file that reveals the cycle. Errors flush immediately — and because a
// SYNCHRONOUS runaway that trips Svelte's `effect_update_depth_exceeded`
// unwinds the stack, the ensuing `window.onerror` still fires and flushes the
// buffered trail that led up to it.

import { API_BASE_URL } from "$lib/api/base-url";

const ENABLED: boolean = (() => {
  if (typeof window === "undefined") return false;
  if (import.meta.env?.DEV) return true;
  try {
    return window.localStorage.getItem("revv:debug-log") === "1";
  } catch {
    return false;
  }
})();

export function debugLogEnabled(): boolean {
  return ENABLED;
}

function post(entries: string[]): void {
  if (entries.length === 0) return;
  try {
    void fetch(`${API_BASE_URL}/api/_debug/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
      keepalive: true,
    }).catch(() => {
      /* diagnostics are best-effort */
    });
  } catch {
    /* ignore */
  }
}

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushNow(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  post(batch);
}

/**
 * Record one breadcrumb. Cheap no-op when disabled. `immediate` forces a flush
 * (used for errors); otherwise entries batch on a 200ms timer.
 */
export function debugLog(line: string, immediate = false): void {
  if (!ENABLED) return;
  const t = typeof performance !== "undefined" ? Math.round(performance.now()) : 0;
  buffer.push(`+${t}ms ${line}`);
  if (immediate || buffer.length >= 200) {
    flushNow();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(flushNow, 200);
  }
}

let installed = false;

/** Install global handlers that capture uncaught errors + unhandled rejections. */
export function installDebugLogCapture(): void {
  if (!ENABLED || installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const stack = event.error instanceof Error ? event.error.stack : "";
    debugLog(
      `ERROR ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}\n${stack ?? ""}`,
      true,
    );
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : "";
    debugLog(`UNHANDLED_REJECTION ${msg}\n${stack ?? ""}`, true);
  });

  debugLog(`capture installed (channel=${import.meta.env?.MODE ?? "?"})`, true);
}
