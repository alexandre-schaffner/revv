/**
 * A GitHub label's hex color, read as OKLCH hue and chroma.
 *
 * GitHub labels are user-picked and often neon (`#00ff00`, `#ffff00`); drawn
 * raw on warm paper they shout and their text fails contrast. Revv keeps only
 * the label's identity (its hue, and whether it has any color at all) and
 * draws it through `LabelChip`'s fixed lightness ramp, which holds ≥4.5:1 in
 * both themes.
 */
export interface LabelHue {
  /** OKLCH hue in degrees, 0–360. */
  readonly h: number;
  /** OKLCH chroma, unclamped. */
  readonly c: number;
}

function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function labelHue(hex: string): LabelHue {
  const clean = hex.replace(/^#/, "");
  const value = /^[0-9a-f]{6}$/i.test(clean) ? clean : "888888";
  const r = srgbToLinear(Number.parseInt(value.slice(0, 2), 16));
  const g = srgbToLinear(Number.parseInt(value.slice(2, 4), 16));
  const b = srgbToLinear(Number.parseInt(value.slice(4, 6), 16));

  // Linear sRGB → OKLab (Björn Ottosson's reference matrices).
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const c = Math.hypot(a, bb);
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { h: Number(h.toFixed(1)), c: Number(c.toFixed(3)) };
}
