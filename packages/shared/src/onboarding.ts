/**
 * SSE frames while the server runs an agent's official install script. The
 * stream closes after `done`; on failure the message lives in `error`.
 */
export type InstallEvent =
  | { type: "log"; line: string }
  | { type: "done"; success: boolean; error?: string };

/**
 * SSE frames while the server drives an agent's interactive CLI login in a
 * pseudo-terminal (e.g. `codex login`). `data` is a raw terminal chunk;
 * `auth-url` is the first `https?://…` the CLI printed. The stream closes
 * after `done`, whose `success` reflects a fresh auth re-check; on failure the
 * message lives in `error`.
 */
export type LoginEvent =
  | { type: "data"; chunk: string }
  | { type: "auth-url"; url: string }
  | { type: "done"; success: boolean; error?: string };
