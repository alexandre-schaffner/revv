import { describe, expect, it } from "bun:test";
import { resolveDesktopCodexBin } from "./cli-agent";

describe("resolveDesktopCodexBin", () => {
  it("uses the first executable bundled Codex CLI", () => {
    const first = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const second = "/Users/alex/Applications/ChatGPT.app/Contents/Resources/codex";

    expect(resolveDesktopCodexBin([first, second], (path) => path === second)).toBe(second);
  });

  it("does not return a desktop bundle path that is not executable", () => {
    expect(
      resolveDesktopCodexBin(["/Applications/ChatGPT.app/Contents/Resources/codex"], () => false),
    ).toBeNull();
  });
});
