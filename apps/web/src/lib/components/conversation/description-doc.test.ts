import { describe, expect, it } from "bun:test";
import type { JSONContent } from "@tiptap/core";
import { DescriptionCodec, descriptionExtensions } from "./description-doc";

const codec = new DescriptionCodec(descriptionExtensions());

const BODY = `## TL;DR

Operators *request* a __perm__.
Second line \`code\`.

<!-- template: keep this -->

1) one
2) two

* [ ] task a
* [x] task b

| a | b |
|---|---|
| 1 | 2 |

\`\`\`ts
const x = 1;
\`\`\`

> quote

<details><summary>More</summary>

hidden

</details>

***

See [the docs][docs] and https://example.com.

[docs]: https://docs.example.com
`;

/** Replaces the text of the first text node inside the top-level node at `index`. */
function editText(doc: JSONContent, index: number, text: string): JSONContent {
  const content = [...(doc.content ?? [])];
  const replace = (node: JSONContent): JSONContent | null => {
    if (node.type === "text") return { ...node, text };
    for (const [i, child] of (node.content ?? []).entries()) {
      const next = replace(child);
      if (next)
        return { ...node, content: node.content?.map((c, j) => (j === i ? next : c)) ?? [] };
    }
    return null;
  };
  const target = content[index];
  if (!target) throw new Error(`no node at ${index}`);
  content[index] = replace(target) ?? target;
  return { ...doc, content };
}

describe("DescriptionCodec", () => {
  it("returns an untouched body byte for byte", () => {
    for (const body of [BODY, "", "plain", "\n\nleading\n\n\ntrailing\n\n", "a\nb\n- x\n- y"]) {
      const { doc, source } = codec.parse(body);
      expect(codec.serialize(doc, source)).toBe(body);
    }
  });

  it("keeps HTML comments and details out of the rich text", () => {
    const { doc } = codec.parse(BODY);
    const raws = (doc.content ?? [])
      .filter((node) => node.type === "rawBlock")
      .map((node) => node.attrs?.raw);
    expect(raws).toContain("<!-- template: keep this -->");
    expect(raws).toContain("[docs]: https://docs.example.com");
  });

  it("rewrites only the block that changed", () => {
    const { doc, source } = codec.parse(BODY);
    const next = codec.serialize(editText(doc, 0, "Summary"), source);
    expect(next).toBe(BODY.replace("## TL;DR", "## Summary"));
  });

  it("keeps reference links working in an edited paragraph", () => {
    const body = "See [the docs][docs] now.\n\n[docs]: https://docs.example.com\n";
    const { doc, source } = codec.parse(body);
    const paragraph = doc.content?.[0];
    const edited: JSONContent = {
      ...doc,
      content: [
        { ...paragraph, content: [{ type: "text", text: "Read " }, ...(paragraph?.content ?? [])] },
        ...(doc.content ?? []).slice(1),
      ],
    };
    expect(codec.serialize(edited, source)).toBe(
      "Read See [the docs](https://docs.example.com) now.\n\n[docs]: https://docs.example.com\n",
    );
  });

  it("separates a block typed after the last one with a blank line", () => {
    const { doc, source } = codec.parse("first");
    const edited: JSONContent = {
      ...doc,
      content: [
        ...(doc.content ?? []),
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    };
    expect(codec.serialize(edited, source)).toBe("first\n\nsecond");
  });

  it("serializes a cleared description as empty", () => {
    const { source } = codec.parse(BODY);
    expect(codec.serialize({ type: "doc", content: [{ type: "paragraph" }] }, source)).toBe("");
  });
});
