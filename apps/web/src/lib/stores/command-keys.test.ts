import { describe, expect, it } from "bun:test";
import { type Command, findBoundCommand, shortcutLabel } from "./command-keys";

function keydown(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    metaKey: true,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

const noop = () => {};

describe("findBoundCommand", () => {
  it("needs ⌘ and matches Shift/Option exactly", () => {
    const cmd: Command = { id: "b", label: "B", keys: { key: "b" }, run: noop };
    expect(findBoundCommand([cmd], keydown({ key: "b" }))).toBe(cmd);
    expect(findBoundCommand([cmd], keydown({ key: "B", shiftKey: true }))).toBeUndefined();
    expect(findBoundCommand([cmd], keydown({ key: "b", metaKey: false }))).toBeUndefined();
  });

  it("matches `code` bindings on the physical key", () => {
    const cmd: Command = { id: "p", label: "P", keys: { code: "KeyB", alt: true }, run: noop };
    expect(findBoundCommand([cmd], keydown({ key: "∫", code: "KeyB", altKey: true }))).toBe(cmd);
  });

  it("lets a later registration shadow an earlier one on the same keys", () => {
    const global: Command = { id: "g", label: "G", keys: { key: "1" }, run: noop };
    const page: Command = { id: "p", label: "P", keys: { key: "1" }, run: noop };
    expect(findBoundCommand([global, page], keydown({ key: "1" }))).toBe(page);
  });

  it("skips unavailable commands and falls through to earlier ones", () => {
    const global: Command = { id: "g", label: "G", keys: { key: "w" }, run: noop };
    const off: Command = { id: "o", label: "O", keys: { key: "w" }, when: () => false, run: noop };
    expect(findBoundCommand([global, off], keydown({ key: "w" }))).toBe(global);
  });
});

describe("shortcutLabel", () => {
  it("orders modifiers the macOS way", () => {
    expect(shortcutLabel({ code: "KeyC", shift: true })).toBe("⇧⌘C");
    expect(shortcutLabel({ code: "KeyB", alt: true })).toBe("⌥⌘B");
    expect(shortcutLabel({ code: "ArrowUp", alt: true })).toBe("⌥⌘↑");
    expect(shortcutLabel({ key: "," })).toBe("⌘,");
  });
});
