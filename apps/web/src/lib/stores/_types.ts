export type RequestState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "ok"; readonly data: T };

export const RequestState = {
  idle: <T>(): RequestState<T> => ({ status: "idle" }),
  loading: <T>(): RequestState<T> => ({ status: "loading" }),
  error: <T>(error: string): RequestState<T> => ({ status: "error", error }),
  ok: <T>(data: T): RequestState<T> => ({ status: "ok", data }),
};
