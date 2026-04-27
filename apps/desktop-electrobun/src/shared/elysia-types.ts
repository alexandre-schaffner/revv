import type { Elysia } from "elysia";

// Standalone type for Eden treaty - mirrors the Elysia app shape
// without importing the actual server implementation
export type ElysiaApp = Elysia<
  "",
  {
    request: {};
    store: {};
    derive: {};
    resolve: {};
    decorator: {};
    schema: {};
    type: {};
    error: {};
    macro: {};
    macroFn: {};
  }
>;
