/**
 * How long an ask that needs a PR's diff in the server's cache waits for
 * `diff:cached` before giving up. The review page's diff load fills it; a
 * 3 000-file PR takes ~20 s of GitHub pages.
 */
export const DIFF_FILL_WAIT_MS = 60_000;
