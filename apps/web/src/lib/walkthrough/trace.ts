// Off by default. Enable with `localStorage.setItem("revv:wt-trace", "1")` and
// a reload. Pairs with the server's `debug("wt-trace", ...)` lines, which need
// `REVV_DEBUG=1`.

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
