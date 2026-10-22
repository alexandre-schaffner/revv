import type { OwnerPalette } from "$lib/utils/avatarPalette";
import type { EngravingInk } from "$lib/utils/engraving";

type Theme = "light" | "dark";

const PAPER = { light: [0.95, 0.028, 85], dark: [0.86, 0.03, 85] } as const;

export function oklchToHex(l: number, c: number, h: number): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return `#${linear
    .map((v) => {
      const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

function hueOf(palette: OwnerPalette): { hue: number; chroma: number } {
  return palette.kind === "color" ? { hue: palette.hue, chroma: 1 } : { hue: 260, chroma: 0.15 };
}

export function repoInk(palette: OwnerPalette, theme: Theme): EngravingInk {
  const { hue, chroma } = hueOf(palette);
  const [pl, pc, ph] = PAPER[theme];
  return {
    ink:
      theme === "light"
        ? oklchToHex(0.37, 0.13 * chroma, hue)
        : oklchToHex(0.31, 0.1 * chroma, hue),
    paper: oklchToHex(pl, pc, ph),
  };
}

export function repoInkRamp(palette: OwnerPalette, theme: Theme): string[] {
  const { hue, chroma } = hueOf(palette);
  const steps =
    theme === "light"
      ? [
          [0.745, 0.08],
          [0.64, 0.11],
          [0.51, 0.12],
          [0.38, 0.12],
        ]
      : [
          [0.43, 0.08],
          [0.55, 0.1],
          [0.67, 0.11],
          [0.81, 0.1],
        ];
  return steps.map(([l = 0, c = 0]) => oklchToHex(l, c * chroma, hue));
}
