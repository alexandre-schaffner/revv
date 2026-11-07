import { describe, expect, it } from "bun:test";
import {
  type Command,
  findBareCommand,
  findBoundCommand,
  shortcutLabel,
  startsChord,
} from "./command-keys";

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

describe("findBareCommand", () => {
  const bare = (key: string) => keydown({ key, metaKey: false });

  it("matches the key exactly, so case carries Shift", () => {
    const last: Command = { id: "l", label: "L", keys: { bare: ["G"] }, run: noop };
    expect(findBareCommand([last], bare("G"), null)).toBe(last);
    expect(findBareCommand([last], bare("g"), null)).toBeUndefined();
  });

  it("never answers a ⌘ binding, nor a bare one to findBoundCommand", () => {
    const mod: Command = { id: "m", label: "M", keys: { key: "j" }, run: noop };
    const plain: Command = { id: "p", label: "P", keys: { bare: ["j"] }, run: noop };
    expect(findBareCommand([mod], bare("j"), null)).toBeUndefined();
    expect(findBoundCommand([plain], keydown({ key: "j" }))).toBeUndefined();
  });

  it("completes a chord only after its first key, and prefers it to a plain binding", () => {
    const top: Command = { id: "t", label: "T", keys: { bare: ["g"], after: "g" }, run: noop };
    const plain: Command = { id: "p", label: "P", keys: { bare: ["g"] }, run: noop };
    expect(findBareCommand([top], bare("g"), null)).toBeUndefined();
    expect(startsChord([top], bare("g"))).toBe(true);
    expect(findBareCommand([top, plain], bare("g"), "g")).toBe(top);
    expect(findBareCommand([top, plain], bare("g"), null)).toBe(plain);
  });

  it("falls back to a plain binding when the pending chord doesn't continue", () => {
    const top: Command = { id: "t", label: "T", keys: { bare: ["g"], after: "g" }, run: noop };
    const down: Command = { id: "d", label: "D", keys: { bare: ["j"] }, run: noop };
    expect(findBareCommand([top, down], bare("j"), "g")).toBe(down);
  });

  it("lets the later of two available scopes win, and skips unavailable ones", () => {
    const sidebar: Command = { id: "s", label: "S", keys: { bare: ["l"] }, run: noop };
    const tab: Command = {
      id: "t",
      label: "T",
      keys: { bare: ["l"] },
      when: () => false,
      run: noop,
    };
    expect(findBareCommand([sidebar, tab], bare("l"), null)).toBe(sidebar);
    expect(startsChord([{ ...tab, keys: { bare: ["g"], after: "g" } }], bare("g"))).toBe(false);
  });
});

describe("shortcutLabel", () => {
  it("orders modifiers the macOS way", () => {
    expect(shortcutLabel({ code: "KeyC", shift: true })).toBe("⇧⌘C");
    expect(shortcutLabel({ code: "KeyB", alt: true })).toBe("⌥⌘B");
    expect(shortcutLabel({ code: "ArrowUp", alt: true })).toBe("⌥⌘↑");
    expect(shortcutLabel({ key: "," })).toBe("⌘,");
    expect(shortcutLabel({ bare: ["g"], after: "g" })).toBe("gg");
  });
});
