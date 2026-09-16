import { describe, expect, it } from "bun:test";
import { decodePlainText } from "./agent-text";

describe("decodePlainText", () => {
  it("decodes the entity agents actually emit in chapter titles", () => {
    // The bug this exists for: stored verbatim, Svelte escapes the string a
    // second time and the reader sees a literal `&amp;` in the header.
    expect(decodePlainText("Context &amp; design decisions")).toBe("Context & design decisions");
  });

  it("decodes the rest of the common named entities", () => {
    expect(decodePlainText("&lt;Suspense&gt; boundary")).toBe("<Suspense> boundary");
    expect(decodePlainText("the &quot;fast&quot; path")).toBe('the "fast" path');
    expect(decodePlainText("caller&apos;s contract")).toBe("caller's contract");
    expect(decodePlainText("a&nbsp;b")).toBe("a b");
  });

  it("decodes numeric and hex references", () => {
    expect(decodePlainText("Tokens &#38; scopes")).toBe("Tokens & scopes");
    expect(decodePlainText("Tokens &#x26; scopes")).toBe("Tokens & scopes");
  });

  it("decodes in a single pass, so double-escaped input keeps one layer", () => {
    // Matches browser behaviour: `&amp;lt;` is the text `&lt;`, not `<`.
    expect(decodePlainText("&amp;lt;div&amp;gt;")).toBe("&lt;div&gt;");
  });

  it("leaves unrecognized and malformed entities alone rather than dropping them", () => {
    expect(decodePlainText("Rate &limit; handling")).toBe("Rate &limit; handling");
    expect(decodePlainText("A & B")).toBe("A & B");
    expect(decodePlainText("filter&exclude")).toBe("filter&exclude");
    expect(decodePlainText("&#1114112;")).toBe("&#1114112;");
  });

  it("trims, replacing the plain .trim() the handlers used to do inline", () => {
    expect(decodePlainText("  Migration safety  ")).toBe("Migration safety");
    expect(decodePlainText("   ")).toBe("");
  });

  it("leaves a clean title untouched", () => {
    expect(decodePlainText("Token validation changes")).toBe("Token validation changes");
  });
});
