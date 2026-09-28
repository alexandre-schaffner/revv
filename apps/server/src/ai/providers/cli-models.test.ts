import { describe, expect, it } from "bun:test";
import { parseOpencodeModelList, parseOpencodeVerboseModels } from "./cli-models";

describe("parseOpencodeModelList", () => {
  it("maps opencode 2's /api/model rows to provider/model options", () => {
    const body = JSON.stringify({
      location: { directory: "/tmp" },
      data: [
        { id: "mimo-v2.6-flash-free", providerID: "opencode", name: "MiMo Free", enabled: true },
        { id: "big-pickle", providerID: "opencode", name: "Big Pickle", enabled: true },
        { id: "old", providerID: "opencode", name: "Old", enabled: false },
        { id: "claude-opus-5", providerID: "github-copilot", name: "", enabled: true },
        { providerID: "broken" },
      ],
    });
    expect(parseOpencodeModelList(body)).toEqual([
      { label: "github-copilot/claude-opus-5", value: "github-copilot/claude-opus-5" },
      { label: "Big Pickle", value: "opencode/big-pickle" },
      { label: "MiMo Free", value: "opencode/mimo-v2.6-flash-free" },
    ]);
  });

  it("treats a still-settling empty snapshot as no models", () => {
    expect(parseOpencodeModelList('{"location":{"directory":"/tmp"},"data":[]}')).toEqual([]);
  });
});

describe("parseOpencodeVerboseModels", () => {
  it("maps opencode 1's `models --verbose` blobs to provider/model options", () => {
    const text = [
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "providerID": "opencode",',
      '  "name": "Big Pickle",',
      '  "api": { "id": "big-pickle", "url": "https://opencode.ai/zen/v1" }',
      "}",
      "anthropic/claude-sonnet-5",
      "{",
      '  "id": "claude-sonnet-5",',
      '  "providerID": "anthropic",',
      '  "name": "Claude Sonnet 5"',
      "}",
      "",
    ].join("\n");
    expect(parseOpencodeVerboseModels(text)).toEqual([
      { label: "Claude Sonnet 5", value: "anthropic/claude-sonnet-5" },
      { label: "Big Pickle", value: "opencode/big-pickle" },
    ]);
  });
});
