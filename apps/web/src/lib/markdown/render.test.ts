import { describe, expect, it, mock } from "bun:test";

// No DOM under bun test: DOMPurify can't run, so sanitizing passes through
// and the policy it applies to external HTML is tested on its own below.
const passThrough = { addHook: () => {}, sanitize: (html: string) => html };
mock.module("dompurify", () => ({ default: Object.assign(() => passThrough, passThrough) }));
mock.module("./highlighter.svelte", () => ({
  highlightCode: () => null,
  isHighlighterReady: () => true,
}));

const { externalAttribute, renderMarkdownBlocks, splitAgentMarkdown } = await import("./render");
const { diagramSource } = await import("./prlens-fence");

const agent = (source: string) => renderMarkdownBlocks(source, "agent").join("");

function placeholderSource(html: string): string | null {
  const encoded = /data-prlens-src="([^"]*)"/.exec(html)?.[1] ?? null;
  return diagramSource({ getAttribute: () => encoded } as unknown as HTMLElement);
}

describe("renderMarkdownBlocks", () => {
  it("turns an agent's prlens fence into a diagram placeholder carrying its source", () => {
    const source = '{"title":"Données → café"}';
    const html = agent(`\`\`\`prlens\n${source}\n\`\`\``);
    expect(html).toContain('class="prlens-diagram not-prose"');
    expect(placeholderSource(html)).toBe(source);
  });

  it("leaves a prlens fence in external markdown as escaped code", () => {
    const html = renderMarkdownBlocks('```prlens\n{"a":"<b>"}\n```', "external").join("");
    expect(html).not.toContain("prlens-diagram");
    expect(html).toContain('<code class="language-prlens">{"a":"&lt;b&gt;"}');
  });

  it("reads an agent's literal \\n as a newline, and keeps an external author's", () => {
    expect(agent("one\\n\\ntwo")).toBe("<p>one</p>\n<p>two</p>\n");
    expect(renderMarkdownBlocks("one\\ntwo", "external")).toEqual(["<p>one\\ntwo</p>\n"]);
  });

  it("renders each top-level block on its own", () => {
    expect(renderMarkdownBlocks("# Title\n\nBody\n\n- a\n- b", "agent")).toEqual([
      "<h1>Title</h1>\n",
      "<p>Body</p>\n",
      "<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n",
    ]);
  });

  it("renders a source whose blocks reach across each other as one", () => {
    expect(renderMarkdownBlocks("See [docs][d].\n\n[d]: https://example.com", "agent")).toEqual([
      '<p>See <a href="https://example.com">docs</a>.</p>\n',
    ]);
    expect(renderMarkdownBlocks("<details>\n\n**inside**\n\n</details>", "external")).toHaveLength(
      1,
    );
  });

  it("wraps tables in a scroll container", () => {
    const html = agent("| a |\n| - |\n| 1 |");
    expect(html.startsWith('<div class="prose-table not-prose" tabindex="0"><table>')).toBe(true);
    expect(html.trimEnd().endsWith("</table></div>")).toBe(true);
  });
});

describe("splitAgentMarkdown", () => {
  it("lists the non-blank top-level blocks as source", () => {
    expect(splitAgentMarkdown("First\\n\\nSecond **bold")).toEqual(["First", "Second **bold"]);
  });
});

describe("externalAttribute", () => {
  it("keeps a style that only sets colors", () => {
    const style = "color:#fff;background-color:#000;--shiki-dark:#abc";
    expect(externalAttribute("style", style)).toBe(style);
  });

  it("drops a style that can move or cover anything", () => {
    expect(externalAttribute("style", "color:red;position:fixed;inset:0")).toBeNull();
  });

  it("keeps only the renderer's own class names", () => {
    expect(externalAttribute("class", "shiki fixed inset-0 language-ts z-50")).toBe(
      "shiki language-ts",
    );
    expect(externalAttribute("class", "fixed inset-0")).toBeNull();
  });

  it("leaves other attributes alone", () => {
    expect(externalAttribute("href", "https://example.com")).toBe("https://example.com");
  });
});
