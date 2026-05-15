// Public API for the unified dot-matrix package. All 24 variants — the 4
// legacy ones used by `GuidedWalkthrough.svelte` and the 20 `square-N`
// variants ported from https://dotmatrix.zzzzshawn.cloud — flow through the
// same registry and component dispatch.

export { default as Dotmatrix } from "./Dotmatrix.svelte";
export { squareVariantForId } from "./random";
export {
  DOTMATRIX_VARIANT_KEYS,
  DOTMATRIX_VARIANTS,
  type DotmatrixVariant,
  type PerDotConfig,
  type VariantConfig,
} from "./variants";
