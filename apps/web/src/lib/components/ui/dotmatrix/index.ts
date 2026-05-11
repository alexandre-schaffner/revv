// Public API for the unified dot-matrix package. All 24 variants — the 4
// legacy ones used by `GuidedWalkthrough.svelte` and the 20 `square-N`
// variants ported from https://dotmatrix.zzzzshawn.cloud — flow through the
// same registry and component dispatch.

export { default as Dotmatrix } from './Dotmatrix.svelte';
export {
	DOTMATRIX_VARIANTS,
	DOTMATRIX_VARIANT_KEYS,
	type DotmatrixVariant,
	type VariantConfig,
	type PerDotConfig,
} from './variants';
export { squareVariantForId } from './random';
