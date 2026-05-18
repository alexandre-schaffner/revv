/**
 * Deterministic hash of a string into a 32-bit unsigned integer.
 */
function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Curated color pairs that look great as fluid gradients. */
const PALETTES = [
  ["hsl(270, 60%, 50%)", "hsl(340, 80%, 65%)"], // purple → pink
  ["hsl(200, 70%, 50%)", "hsl(160, 60%, 55%)"], // blue → teal
  ["hsl(350, 80%, 60%)", "hsl(45, 90%, 60%)"],  // red → gold
  ["hsl(260, 50%, 50%)", "hsl(25, 90%, 65%)"],  // purple → orange
  ["hsl(170, 70%, 40%)", "hsl(190, 50%, 50%)"], // teal → cyan
  ["hsl(220, 70%, 50%)", "hsl(200, 80%, 55%)"], // blue → sky
  ["hsl(15, 90%, 65%)", "hsl(40, 90%, 60%)"],   // coral → gold
  ["hsl(280, 50%, 50%)", "hsl(320, 70%, 55%)"], // purple → magenta
  ["hsl(160, 70%, 50%)", "hsl(150, 30%, 45%)"], // mint → sage
  ["hsl(340, 80%, 65%)", "hsl(15, 90%, 65%)"],  // rose → coral
  ["hsl(220, 70%, 50%)", "hsl(270, 50%, 50%)"], // blue → purple
  ["hsl(55, 90%, 60%)", "hsl(40, 90%, 60%)"],   // lemon → gold
  ["hsl(190, 80%, 40%)", "hsl(170, 70%, 40%)"], // cyan → teal
  ["hsl(320, 60%, 55%)", "hsl(340, 80%, 65%)"], // magenta → rose
  ["hsl(150, 30%, 45%)", "hsl(160, 40%, 45%)"], // sage → seafoam
  ["hsl(15, 90%, 65%)", "hsl(55, 90%, 60%)"],   // coral → lemon
  ["hsl(270, 50%, 50%)", "hsl(220, 70%, 50%)"], // purple → blue
  ["hsl(40, 90%, 60%)", "hsl(15, 90%, 65%)"],   // gold → coral
  ["hsl(160, 70%, 50%)", "hsl(190, 80%, 40%)"], // mint → cyan
  ["hsl(340, 80%, 65%)", "hsl(320, 60%, 55%)"], // rose → magenta
] as const;

const BLEND_MODES = [
  "color-dodge",
  "hard-light",
  "overlay",
  "soft-light",
  "screen",
  "lighten",
] as const;

/**
 * Generate a deterministic ffflux-style fluid SVG gradient data URL
 * for a given seed string (e.g. a repository full name like "owner/name").
 *
 * The same seed always produces the same gradient so avatars are stable
 * across renders and sessions.
 */
export function repoGradientDataUrl(seed: string): string {
  const h = hashString(seed);

  const palette = PALETTES[h % PALETTES.length]!;
  const color1 = palette[0];
  const color2 = palette[1];
  const angle = h % 360;
  const turbulenceSeed = 1 + (h % 999);
  const baseFreqX = 0.001 + ((h % 7) * 0.001);
  const baseFreqY = 0.001 + (((h >> 4) % 7) * 0.001);
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

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
