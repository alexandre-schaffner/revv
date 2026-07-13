// Diagnostic-only walkthrough trace logger.
//
// Off by default to keep the DevTools console quiet. Enable in any browser
// session by running `localStorage.setItem("revv:wt-trace", "1")` and
// reloading; disable with `localStorage.removeItem("revv:wt-trace")`.
//
// Pairs with `debug("wt-trace", ...)` calls on the server side. When
// investigating, also enable `REV_DEBUG=1` on the server so the matched
// `[wt-trace]` lines surface in both vantage points.

const ENABLED: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("revv:wt-trace") === "1";
  } catch {
    return false;
  }
})();

export function wtTrace(scope: string, ...args: unknown[]): void {
  if (!ENABLED) return;
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.debug(`[wt-trace] [${scope}] ${msg}`);
}
