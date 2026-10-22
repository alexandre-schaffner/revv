// Client-local diff rendering preferences. Like the diff theme, these are
// per-machine display choices rather than account settings, so they live in
// localStorage and never round-trip through the server.

const DIFF_WRAP_KEY = "revv-diff-wrap";

function readWrap(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(DIFF_WRAP_KEY) === "1";
}

let diffWrap = $state(readWrap());

/** Whether long diff lines soft-wrap instead of scrolling horizontally. */
export function getDiffWrap(): boolean {
  return diffWrap;
}

export function setDiffWrap(wrap: boolean): void {
  diffWrap = wrap;
  localStorage.setItem(DIFF_WRAP_KEY, wrap ? "1" : "0");
}
