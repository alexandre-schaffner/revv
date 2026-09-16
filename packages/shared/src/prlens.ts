// ── prlens ───────────────────────────────────────────────────────────────────
//
// The shape a `prlens` fence body must take on before it can be handed to
// `@coldtea/pr-lens-schema`. Shared because the document is validated twice
// against the same contract: once on the server when an agent writes the block
// (so a rejected diagram never reaches the reader), and once in the web app
// when the fence is rendered. Two copies of this wrapper would let the two
// verdicts drift.

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
 * Wrap a fence body into a full graph document.
 *
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
