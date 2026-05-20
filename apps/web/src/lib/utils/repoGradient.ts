import { hashString } from "./avatarPalette";

const BLEND_MODES = [
  "color-dodge",
  "hard-light",
  "overlay",
  "soft-light",
  "screen",
  "lighten",
] as const;

/** Convert a hue (0–360), saturation (0–100), and lightness (0–100) to an hsl string. */
function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h % 360)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

interface DerivedColors {
  background: [string, string];
  text: [string, string];
}

/**
 * Derive two harmonious background colors and two light text-tint colors
 * from an owner hue and a repo seed.
 */
function deriveColors(ownerHue: number, repoSeed: number): DerivedColors {
  const r = repoSeed;

  // 10 different harmonic relationships
  const relationships = [
    (h: number) => h + 30, // analogous warm
    (h: number) => h - 30, // analogous cool
    (h: number) => h + 120, // triadic +120
    (h: number) => h - 120, // triadic -120
    (h: number) => h + 180, // complementary
    (h: number) => h + 150, // split-complementary warm
    (h: number) => h - 150, // split-complementary cool
    (h: number) => h + 45, // warm shift
    (h: number) => h - 45, // cool shift
    (h: number) => h + 160, // near-complementary
  ];

  const idx = r % relationships.length;
  const relFn = relationships[idx];
  if (!relFn) {
    const fallback = hsl(ownerHue, 50, 50);
    return {
      background: [fallback, fallback],
      text: [hsl(ownerHue, 10, 95), hsl(ownerHue, 15, 90)],
    };
  }
  const hue2 = relFn(ownerHue);

  // Saturation jitter: both stops share a base, with a small differential
  const sBase = 50 + ((r >> 4) % 25); // 50–74%
  const sDiff = ((r >> 8) % 11) - 5; // -5..+5
  const sat1 = sBase + sDiff;
  const sat2 = sBase - sDiff;

  // Lightness jitter: one stop is darker, one lighter
  const lBase = 45 + ((r >> 12) % 20); // 45–64%
  const lDiff = 8 + ((r >> 16) % 7); // 8–14
  const light1 = lBase - lDiff;
  const light2 = lBase + lDiff;

  return {
    background: [hsl(ownerHue, sat1, light1), hsl(hue2, sat2, light2)],
    text: [
      `hsl(0, 0%, 99%)`,
      `hsl(${Math.round(ownerHue % 360)}, 25%, 92%)`,
    ],
  };
}

export interface RepoGradient {
  url: string;
  textGradient: string;
}

/**
 * Generate a deterministic ffflux-style fluid SVG gradient data URL
 * for a given repository, plus a CSS text gradient that echoes the palette.
 *
 * The `ownerHue` (extracted from the owner's GitHub avatar, or a
 * fallback hash) drives the color palette.  The `repoFullName` seed
 * controls geometric variation (angle, turbulence, blur, blend mode)
 * and the harmonic relationship between the two gradient stops.
 *
 * The same inputs always produce the same gradient so avatars are
 * stable across renders and sessions.
 */
export function repoGradientDataUrl(repoFullName: string, ownerHue: number): RepoGradient {
  const h = hashString(repoFullName);

  const {
    background: [color1, color2],
    text: [text1, text2],
  } = deriveColors(ownerHue, h);

  const angle = h % 360;
  const turbulenceSeed = 1 + (h % 999);
  const baseFreqX = 0.001 + (h % 7) * 0.001;
  const baseFreqY = 0.001 + ((h >> 4) % 7) * 0.001;
  const numOctaves = 1 + (h % 2);
  const blurX = 15 + (h % 30);
  const blurY = 0 + ((h >> 8) % 20);
  const blendMode = BLEND_MODES[h % BLEND_MODES.length];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 700" width="700" height="700">
  <defs>
    <linearGradient gradientTransform="rotate(${angle} .5 .5)" x1="50%" y1="0%" x2="50%" y2="100%" id="g">
      <stop stop-color="${color1}" offset="0%"/>
      <stop stop-color="${color2}" offset="100%"/>
    </linearGradient>
    <filter id="f" x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="${baseFreqX.toFixed(3)} ${baseFreqY.toFixed(3)}" numOctaves="${numOctaves}" seed="${turbulenceSeed}" stitchTiles="stitch" x="0%" y="0%" width="100%" height="100%" result="turbulence"/>
      <feGaussianBlur stdDeviation="${blurX} ${blurY}" x="0%" y="0%" width="100%" height="100%" in="turbulence" result="blur"/>
      <feBlend mode="${blendMode}" x="0%" y="0%" width="100%" height="100%" in="SourceGraphic" in2="blur" result="blend"/>
    </filter>
  </defs>
  <path fill="url(#g)" filter="url(#f)" d="M0 0h700v700H0z"/>
</svg>`;

  const textGradient = `linear-gradient(to bottom, ${text1}, ${text2})`;

  return {
    url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    textGradient,
  };
}
