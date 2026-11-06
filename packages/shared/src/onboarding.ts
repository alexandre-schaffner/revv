/**
 * Event frames emitted over SSE while the server runs the opencode install
 * script (`curl … | bash` on macOS/Linux, `irm … | iex` on Windows). The
 * stream closes after `done`; on failure the message lives in `error`.
 */
export type InstallEvent =
  | { type: "log"; line: string }
  | { type: "done"; success: boolean; error?: string };

/**
 * Event frames emitted over SSE while the server drives an agent's interactive
 * CLI login inside a spawned pseudo-terminal (e.g. `codex login`,
 * `cursor-agent login`). `data` carries a raw terminal chunk to render into an
 * xterm instance; `auth-url` is the first `https?://…` the CLI printed (so the
 * UI can open it in the browser); the stream closes after `done`, whose
 * `success` reflects a fresh auth re-check. On failure the message lives in
 * `error`. Mirrors {@link InstallEvent}'s lifecycle.
 */
export type LoginEvent =
  | { type: "data"; chunk: string }
  | { type: "auth-url"; url: string }
  | { type: "done"; success: boolean; error?: string };
