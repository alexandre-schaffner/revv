import { describe, expect, it } from "bun:test";
import { isTextEditingKeyTarget } from "./utils";

type TargetMock = EventTarget & {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

function keyEvent(path: TargetMock[], target = path[0]): KeyboardEvent {
  return {
    composedPath: () => path,
    target: target ?? null,
  } as unknown as KeyboardEvent;
}

describe("isTextEditingKeyTarget", () => {
  it("detects native text controls from the composed path", () => {
    expect(isTextEditingKeyTarget(keyEvent([{ tagName: "input" } as TargetMock]))).toBe(true);
    expect(isTextEditingKeyTarget(keyEvent([{ tagName: "TEXTAREA" } as TargetMock]))).toBe(true);
    expect(isTextEditingKeyTarget(keyEvent([{ tagName: "select" } as TargetMock]))).toBe(true);
  });

  it("detects contenteditable and textbox targets", () => {
    expect(isTextEditingKeyTarget(keyEvent([{ isContentEditable: true } as TargetMock]))).toBe(
      true,
    );
    expect(
      isTextEditingKeyTarget(
        keyEvent([
          {
            getAttribute: (name: string) => (name === "role" ? "textbox" : null),
          } as TargetMock,
        ]),
      ),
    ).toBe(true);
  });

  it("detects editing ancestors when the concrete event target is a child", () => {
    const child = {} as TargetMock;
    const editor = { isContentEditable: true } as TargetMock;

    expect(isTextEditingKeyTarget(keyEvent([child, editor], child))).toBe(true);
  });

  it("ignores non-editing targets", () => {
    expect(isTextEditingKeyTarget(keyEvent([{ tagName: "button" } as TargetMock]))).toBe(false);
    expect(isTextEditingKeyTarget(keyEvent([{} as TargetMock]))).toBe(false);
  });
});
