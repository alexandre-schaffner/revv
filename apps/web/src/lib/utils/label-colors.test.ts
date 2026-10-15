import { describe, expect, it } from "bun:test";
import { labelHue } from "./label-colors";

// OKLCH → relative luminance, to hold LabelChip's ramp to WCAG AA. The ramp
// below mirrors LabelChip.svelte's CSS: change one, change both.
function luminance(L: number, C: number, hDeg: number): number {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(y1: number, y2: number): number {
  const [hi, lo] = y1 > y2 ? [y1, y2] : [y2, y1];
  return (hi + 0.05) / (lo + 0.05);
}

const GITHUB_DEFAULTS = [
  "d73a4a", // bug
  "0075ca", // documentation
  "cfd3d7", // duplicate
  "a2eeef", // enhancement
  "7057ff", // good first issue
  "008672", // help wanted
  "e4e669", // invalid
  "d876e3", // question
  "ffffff", // wontfix
  "00ff00",
  "ffff00",
  "000000",
];

describe("labelHue", () => {
  it("reads gray as achromatic", () => {
    expect(labelHue("cfd3d7").c).toBeLessThan(0.02);
    expect(labelHue("ffffff").c).toBeLessThan(0.001);
  });

  it("falls back to gray on a malformed color", () => {
    expect(labelHue("nope").c).toBeLessThan(0.001);
  });

  it("keeps LabelChip's text at ≥4.5:1 in both themes", () => {
    for (const hex of GITHUB_DEFAULTS) {
      const { h, c } = labelHue(hex);
      const light = contrast(
        luminance(0.42, Math.min(c, 0.13), h),
        luminance(0.94, Math.min(c, 0.05), h),
      );
      const dark = contrast(
        luminance(0.86, Math.min(c, 0.11), h),
        luminance(0.3, Math.min(c, 0.06), h),
      );
      expect(light).toBeGreaterThanOrEqual(4.5);
      expect(dark).toBeGreaterThanOrEqual(4.5);
    }
  });
});
