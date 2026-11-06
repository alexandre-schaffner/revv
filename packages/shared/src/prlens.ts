// A `prlens` fence is validated against `@coldtea/pr-lens-schema` twice: by
// the server when an agent writes the block, and by the web app when it
// renders. Both must recognise and wrap fences identically, or the server
// accepts a diagram the reader never sees drawn (or rejects one it would have).

/**
 * The renderer never reads provenance — only the manifest builder does, and we
 * do not build manifests — but the schema requires it. Diagram authors write a
 * body, not a document, so a placeholder stands in rather than making every
 * fence repeat the repo and both shas.
 */
const PLACEHOLDER_PROVENANCE = {
  repo: { owner: "revv", name: "walkthrough" },
  base: { sha: "0000000" },
  head: { sha: "1111111" },
};

/**
 * `schemaVersion` and `kind` are ours to state: they identify the contract, not
 * the diagram, and an author guessing at either turns a good document into a
 * rejected one. Provenance is overridable because a fence may legitimately
 * carry real repo coordinates.
 */
export function toGraphDocInput(body: Record<string, unknown>, schemaVersion: string): unknown {
  return {
    ...body,
    schemaVersion,
    kind: "graph",
    provenance: body.provenance ?? PLACEHOLDER_PROVENANCE,
  };
}

const FENCE_LANGS: readonly string[] = ["prlens", "pr-lens"];

export function isPrLensFenceLang(lang: string | null | undefined): boolean {
  return FENCE_LANGS.includes(lang?.trim().toLowerCase() ?? "");
}
