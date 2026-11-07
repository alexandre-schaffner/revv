import { describe, expect, it } from "bun:test";
import {
  attachmentsTotalTooLargeMessage,
  attachmentTooLargeMessage,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_COUNT,
} from "@revv/shared";
import { admitAttachments, type PendingAttachment } from "./attachments";

function file(name: string, size: number, type = ""): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const MB = 1024 * 1024;

describe("admitAttachments", () => {
  it("classifies images by MIME type and source files by extension", () => {
    const { admitted, rejections } = admitAttachments(
      [],
      [file("shot.png", 10, "image/png"), file("App.svelte", 10), file("notes", 10, "text/plain")],
    );
    expect(admitted.map((a) => a.kind)).toEqual(["image", "text", "text"]);
    expect(rejections).toEqual([]);
  });

  it("turns away unsupported types with one message", () => {
    expect(admitAttachments([], [file("a.zip", 1)]).rejections).toEqual([
      "a.zip is not a supported attachment type.",
    ]);
    expect(admitAttachments([], [file("a.zip", 1), file("b.bin", 1)]).rejections).toEqual([
      "2 files are not supported attachment types.",
    ]);
  });

  it("rejects an oversized file when it is added, not on submit", () => {
    const { admitted, rejections } = admitAttachments(
      [],
      [file("big.txt", MAX_CHAT_ATTACHMENT_BYTES + 1), file("ok.txt", 10)],
    );
    expect(admitted.map((a) => a.file.name)).toEqual(["ok.txt"]);
    expect(rejections).toEqual([attachmentTooLargeMessage("big.txt")]);
  });

  it("counts what is already attached against the total cap", () => {
    const current: PendingAttachment[] = [
      { file: file("a.txt", 4 * MB), kind: "text" },
      { file: file("b.txt", 4 * MB), kind: "text" },
    ];
    const { admitted, rejections } = admitAttachments(current, [
      file("c.txt", 4 * MB + 1),
      file("d.txt", 1 * MB),
    ]);
    expect(admitted.map((a) => a.file.name)).toEqual(["d.txt"]);
    expect(rejections).toEqual([attachmentsTotalTooLargeMessage()]);
  });

  it("caps the number of attachments", () => {
    const current = Array.from(
      { length: MAX_CHAT_ATTACHMENTS_COUNT },
      (_, i): PendingAttachment => ({ file: file(`${i}.txt`, 1), kind: "text" }),
    );
    const { admitted, rejections } = admitAttachments(current, [file("one-more.txt", 1)]);
    expect(admitted).toEqual([]);
    expect(rejections).toHaveLength(1);
  });
});
