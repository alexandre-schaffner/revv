/**
 * FNV-1a over UTF-16 code units, multiplying in float space. The float
 * multiply drops low bits once the product passes 2^53, so this is not
 * bit-exact FNV-1a — but avatar swatches and recap theme colours are keyed
 * on these exact outputs, so switching to `Math.imul` would recolour them.
 */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
