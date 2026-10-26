import { type AnyExtension, Extension, getSchema, type JSONContent, Node } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PmNode, type Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

// The PR description, edited in place as rich text but written back as the
// author's markdown. A rich-text round trip normalises everything it touches
// (list markers, emphasis style, table padding, escapes) and drops what it
// can't model (HTML comments from PR templates, `<details>`, link
// definitions), so it only gets to touch what the user changed: every
// top-level block remembers the source it was parsed from, and a block whose
// content is unchanged at save time is written back byte for byte. HTML and
// link definitions never become rich text at all; they ride along as
// `rawBlock` atoms that serialize to their source.

/** Top-level block types that carry their source index. */
const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "taskList",
  "codeBlock",
  "horizontalRule",
  "table",
  "image",
  "rawBlock",
];

const SOURCE_ATTR = "sourceBlock";

/**
 * Markdown the editor can't model, kept verbatim. The node view that renders
 * it lives with the editor component (it needs the sanitizer); this is the
 * schema and serialization half.
 */
export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { raw: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-raw-block]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-raw") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    return ["div", { "data-raw-block": "", "data-raw": String(node.attrs.raw ?? "") }];
  },

  renderMarkdown(node) {
    return String(node.attrs?.raw ?? "");
  },
});

/** Stamps each top-level block with the index of the source block it came from. */
const SourceBlock = Extension.create({
  name: "sourceBlock",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          // Not rendered, so a paste never forges one: pasted blocks are new.
          [SOURCE_ATTR]: { default: null, rendered: false, keepOnSplit: true },
        },
      },
    ];
  },
});

/** The schema extensions, shared by the editor and the markdown manager. */
export function descriptionExtensions(rawBlock: AnyExtension = RawBlock): AnyExtension[] {
  return [
    StarterKit.configure({
      // Markdown has no underline; GitHub would get `<u>` tags.
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true }),
    rawBlock,
    SourceBlock,
  ];
}

/** One top-level markdown block as the author wrote it. */
interface SourceBlockEntry {
  /** The block's source, without surrounding whitespace. */
  readonly raw: string;
  /** Whitespace between this block and the next, verbatim. */
  readonly sep: string;
  /** The block's nodes as the editor normalises them, for change detection. */
  readonly snapshot: string;
}

export interface DescriptionSource {
  /** Whitespace before the first block. */
  readonly lead: string;
  readonly blocks: readonly SourceBlockEntry[];
}

export interface ParsedDescription {
  readonly doc: JSONContent;
  readonly source: DescriptionSource;
}

/** Token types that stay verbatim rather than becoming rich text. */
const RAW_TOKENS = new Set(["html", "def"]);

export class DescriptionCodec {
  readonly #manager: MarkdownManager;
  readonly #schema: Schema;

  constructor(extensions: AnyExtension[]) {
    // GitHub renders a PR body with hard line breaks, as the read-only view does.
    this.#manager = new MarkdownManager({ extensions, markedOptions: { gfm: true, breaks: true } });
    this.#schema = getSchema(extensions);
  }

  parse(markdown: string): ParsedDescription {
    const tokens = this.#manager.instance.lexer(markdown);
    // Parsed one block at a time, a paragraph can't see the link definitions
    // the rest of the body declares; appending them resolves `[text][ref]`.
    const defs = tokens
      .filter((t) => t.type === "def")
      .map((t) => t.raw.trim())
      .join("\n");

    let lead = "";
    const pending: { raw: string; sep: string; nodes: JSONContent[] }[] = [];
    for (const token of tokens) {
      const raw = token.raw.trim();
      const before = token.raw.slice(0, token.raw.length - token.raw.trimStart().length);
      const after = token.raw.slice(token.raw.trimEnd().length);
      const last = pending.at(-1);
      if (!raw) {
        if (last) pending[pending.length - 1] = { ...last, sep: last.sep + token.raw };
        else lead += token.raw;
        continue;
      }
      if (last) pending[pending.length - 1] = { ...last, sep: last.sep + before };
      else lead += before;

      const nodes = RAW_TOKENS.has(token.type)
        ? []
        : (this.#manager.parse(defs ? `${raw}\n\n${defs}` : raw).content ?? []).filter(
            (node) => !isEmptyParagraph(node),
          );
      pending.push({
        raw,
        sep: after,
        nodes: nodes.length > 0 ? nodes : [{ type: "rawBlock", attrs: { raw } }],
      });
    }

    const content = pending.flatMap((block, index) =>
      block.nodes.map((node) => ({ ...node, attrs: { ...node.attrs, [SOURCE_ATTR]: index } })),
    );
    const doc = this.#normalise({
      type: "doc",
      content: content.length > 0 ? content : [{ type: "paragraph" }],
    });
    const groups = groupBlocks(doc);
    const blocks = pending.map((block, index) => ({
      raw: block.raw,
      sep: block.sep,
      snapshot: JSON.stringify(groups.find((g) => g.index === index)?.nodes ?? []),
    }));
    return { doc, source: { lead, blocks } };
  }

  /**
   * The document as markdown: unchanged blocks verbatim with their original
   * spacing, changed and new ones serialized. An untouched document returns
   * exactly the markdown it was parsed from.
   */
  serialize(doc: JSONContent, source: DescriptionSource): string {
    const used = new Set<number>();
    const pieces: { text: string; sep: string; verbatim: boolean }[] = [];
    for (const group of groupBlocks(doc)) {
      const original = group.index === null ? undefined : source.blocks[group.index];
      if (
        original &&
        group.index !== null &&
        !used.has(group.index) &&
        JSON.stringify(group.nodes) === original.snapshot
      ) {
        used.add(group.index);
        pieces.push({ text: original.raw, sep: original.sep, verbatim: true });
        continue;
      }
      const nodes = group.nodes.filter((node) => !isEmptyParagraph(node));
      if (nodes.length === 0) continue;
      const text = this.#manager.serialize({ type: "doc", content: nodes }).trim();
      if (text) pieces.push({ text, sep: original?.sep ?? "", verbatim: false });
    }

    let out = pieces.length > 0 && pieces[0]?.verbatim ? source.lead : "";
    pieces.forEach((piece, i) => {
      out += piece.text;
      const next = pieces[i + 1];
      if (!next) {
        if (piece.verbatim) out += piece.sep;
        return;
      }
      // The source's spacing only separated the blocks it was written
      // between; next to a rewritten block, a blank line is the only safe
      // separator (a single newline lets a paragraph run on into the next).
      const safe = piece.verbatim && next.verbatim;
      out += safe ? piece.sep : piece.sep.split("\n").length > 2 ? piece.sep : "\n\n";
    });
    return out;
  }

  #normalise(doc: JSONContent): JSONContent {
    return PmNode.fromJSON(this.#schema, doc).toJSON() as JSONContent;
  }
}

interface BlockGroup {
  readonly index: number | null;
  readonly nodes: JSONContent[];
}

/** Consecutive top-level nodes that came from the same source block. */
function groupBlocks(doc: JSONContent): BlockGroup[] {
  const groups: { index: number | null; nodes: JSONContent[] }[] = [];
  for (const node of doc.content ?? []) {
    const value = node.attrs?.[SOURCE_ATTR];
    const index = typeof value === "number" ? value : null;
    const last = groups.at(-1);
    if (last && last.index === index) last.nodes.push(node);
    else groups.push({ index, nodes: [node] });
  }
  return groups;
}

function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === "paragraph" && (node.content?.length ?? 0) === 0;
}
