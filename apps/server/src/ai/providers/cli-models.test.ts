import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listOpencodeModels,
  parseOpencodeModelList,
  parseOpencodeVerboseModels,
} from "./cli-models";

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

describe("listOpencodeModels", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in `opencode` whose `api` call fails `apiFailures` times first. */
  function fakeOpencode(options: { apiFailures: number; verbose?: string }): string {
    const dir = mkdtempSync(join(tmpdir(), "revv-opencode-"));
    dirs.push(dir);
    const bin = join(dir, "opencode");
    const verbose = options.verbose;
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `state="${join(dir, "calls")}"`,
        'if [ "$1" = "api" ]; then',
        '  n=$(cat "$state" 2>/dev/null || echo 0); echo $((n + 1)) > "$state"',
        `  [ "$n" -lt ${options.apiFailures} ] && exit 1`,
        `  echo '${JSON.stringify({ data: [{ id: "m", providerID: "p", name: "M" }] })}'`,
        "  exit 0",
        "fi",
        verbose === undefined ? "exit 1" : `printf '%s\\n' '${verbose}'; exit 0`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("retries a failed api call on opencode 2 instead of giving up", async () => {
    expect(await listOpencodeModels(fakeOpencode({ apiFailures: 2 }))).toEqual([
      { label: "M", value: "p/m" },
    ]);
  });

  it("falls back to `models --verbose` on opencode 1", async () => {
    const verbose = `p/v\n${JSON.stringify({ id: "v", providerID: "p", name: "V" })}`;
    expect(
      await listOpencodeModels(fakeOpencode({ apiFailures: Number.MAX_SAFE_INTEGER, verbose })),
    ).toEqual([{ label: "V", value: "p/v" }]);
  });
});
