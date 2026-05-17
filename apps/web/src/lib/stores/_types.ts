/**
 * Tagged union representing the lifecycle of an async load operation.
 * Replaces parallel boolean + nullable data/error fields with a single
 * value that admits only legal states.
 *
 * @example
 * ```ts
 * type FileState = RequestState<ReviewFile[]>;
 * // Consumers branch exhaustively:
 * switch (state.status) {
 *   case 'idle': ...
 *   case 'loading': ...
 *   case 'error': console.error(state.error); ...
 *   case 'ok': render(state.data); ...
 * }
 * ```
 */
export type RequestState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "ok"; readonly data: T };

/** Convenience constructors. */
export const RequestState = {
  idle: <T>(): RequestState<T> => ({ status: "idle" }),
  loading: <T>(): RequestState<T> => ({ status: "loading" }),
  error: <T>(error: string): RequestState<T> => ({ status: "error", error }),
  ok: <T>(data: T): RequestState<T> => ({ status: "ok", data }),
};
