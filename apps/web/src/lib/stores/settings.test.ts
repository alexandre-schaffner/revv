import { beforeEach, describe, expect, it, mock } from "bun:test";

type Answer =
  | { data: { models: { label: string; value: string }[] }; error: null }
  | { data: null; error: { status: number; value: unknown } };

let answer: Answer = { data: { models: [] }, error: null };
let asks = 0;
/** While set, an ask waits for it before answering. */
let gate: Promise<void> | null = null;

mock.module("$lib/api/client", () => ({
  api: {
    api: {
      settings: {
        models: {
          get: async () => {
            asks += 1;
            if (gate) await gate;
            return answer;
          },
        },
      },
    },
  },
}));

// Bun runs this module uncompiled, so the `$state` rune needs a stand-in.
Object.assign(globalThis, { $state: <T>(value: T) => value });
// Other tests mock this module; the query string loads the real one.
const realSettings = "./settings.svelte.ts?real";
const settings: typeof import("./settings.svelte") = await import(realSettings);

const OPENCODE = "opencode";
const refused = (status: number, code: string): Answer => ({
  data: null,
  error: { status, value: { error: "Refused", code } },
});

beforeEach(() => {
  settings.resetModels();
  answer = { data: { models: [] }, error: null };
  asks = 0;
  gate = null;
});

describe("the model catalog", () => {
  it("doesn't count a refusal for want of a session as loaded", async () => {
    answer = refused(401, "UNAUTHORIZED");
    await settings.fetchModels(OPENCODE);
    expect(settings.areModelsLoaded(OPENCODE)).toBe(false);

    answer = { data: { models: [{ label: "A", value: "p/a" }] }, error: null };
    await settings.fetchModels(OPENCODE);
    expect(settings.areModelsLoaded(OPENCODE)).toBe(true);
    expect(settings.getAvailableModels(OPENCODE)).toEqual([{ label: "A", value: "p/a" }]);
  });

  it("counts any other failure as loaded, so a picker shows it instead of loading forever", async () => {
    answer = refused(500, "INTERNAL_ERROR");
    await settings.fetchModels(OPENCODE);
    expect(settings.areModelsLoaded(OPENCODE)).toBe(true);
    expect(settings.getAvailableModels(OPENCODE)).toEqual([]);
  });

  it("is forgotten when the session ends, and an answer still in flight can't land", async () => {
    let release = (): void => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = { data: { models: [{ label: "A", value: "p/a" }] }, error: null };
    const pending = settings.fetchModels(OPENCODE);
    settings.resetModels();
    release();
    await pending;
    expect(settings.areModelsLoaded(OPENCODE)).toBe(false);
    expect(asks).toBe(1);
  });
});
