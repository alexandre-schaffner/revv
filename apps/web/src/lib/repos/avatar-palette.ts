// Owner hue extracted from an avatar image (a data URL for tracked repos, a
// GitHub URL in the add-repo catalog). Results are cached per session, so many
// repos of one owner process one image.

export function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function fallbackOwnerHue(repoFullName: string): number {
  const owner = (repoFullName.split("/")[0] ?? repoFullName).toLowerCase();
  return hashString(owner) % 360;
}

export type OwnerPalette = { kind: "color"; hue: number } | { kind: "neutral"; lightness: number };

export function fallbackOwnerPalette(repoFullName: string): OwnerPalette {
  return { kind: "color", hue: fallbackOwnerHue(repoFullName) };
}

export function peekOwnerPalette(src: string): OwnerPalette | undefined {
  if (typeof document === "undefined") return undefined;
  return sessionPaletteCache.get(src);
}

export async function preloadOwnerHues(
  repos: { avatarUrl: string | null; fullName: string }[],
): Promise<void> {
  if (typeof document === "undefined") return;
  const seen = new Set<string>();
  const loads: Promise<OwnerPalette>[] = [];
  for (const repo of repos) {
    if (repo.avatarUrl && !seen.has(repo.avatarUrl)) {
      seen.add(repo.avatarUrl);
      loads.push(ownerPaletteFromAvatar(repo.avatarUrl, fallbackOwnerPalette(repo.fullName)));
    }
  }
  await Promise.all(loads);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) / 6;
  else if (max === gN) h = ((bN - rN) / d + 2) / 6;
  else h = ((rN - gN) / d + 4) / 6;
  return [h * 360, s, l];
}

// Hue is circular: a linear median of reds at 350° and 5° lands near 177°
// (teal), so the array is cut at its largest gap before taking the median.
function circularMedian(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] ?? 0;

  let maxGap = 0;
  let gapAfterIdx = n - 1;
  for (let i = 0; i < n - 1; i++) {
    const gap = (sorted[i + 1] ?? 0) - (sorted[i] ?? 0);
    if (gap > maxGap) {
      maxGap = gap;
      gapAfterIdx = i;
    }
  }
  const wrapGap = (sorted[0] ?? 0) + 360 - (sorted[n - 1] ?? 0);
  if (wrapGap > maxGap) {
    const mid = sorted[Math.floor(n / 2)] ?? 0;
    return mid % 360;
  }

  const rotated: number[] = [];
  for (let i = gapAfterIdx + 1; i < n; i++) rotated.push((sorted[i] ?? 0) - 360);
  for (let i = 0; i <= gapAfterIdx; i++) rotated.push(sorted[i] ?? 0);

  const median = rotated[Math.floor(n / 2)] ?? 0;
  return ((median % 360) + 360) % 360;
}

function paletteFromImg(img: HTMLImageElement, fallbackPalette: OwnerPalette): OwnerPalette {
  const SIZE = 16;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallbackPalette;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  const weighted: number[] = [];
  let neutralLightness = 0;
  let neutralCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a < 128) continue;
    const [h, s, l] = rgbToHsl(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    if (s < 0.15) {
      if (l >= 0.08 && l <= 0.95) {
        neutralLightness += l;
        neutralCount++;
      }
      continue;
    }
    if (l < 0.1 || l > 0.92) continue;
    const weight = Math.round(s * 4) + 1;
    for (let w = 0; w < weight; w++) weighted.push(h);
  }

  if (weighted.length === 0) {
    if (neutralCount === 0) return fallbackPalette;
    return { kind: "neutral", lightness: neutralLightness / neutralCount };
  }
  weighted.sort((a, b) => a - b);
  return { kind: "color", hue: circularMedian(weighted) };
}

function paletteFromSrc(src: string, fallbackPalette: OwnerPalette): Promise<OwnerPalette> {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = window.setTimeout(() => resolve(fallbackPalette), 1500);
    const finish = (palette: OwnerPalette): void => {
      window.clearTimeout(timeout);
      resolve(palette);
    };
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        finish(paletteFromImg(img, fallbackPalette));
      } catch {
        finish(fallbackPalette);
      }
    };
    img.onerror = () => finish(fallbackPalette);
    img.src = src;
  });
}

const SESSION_HUE_MAX = 200;
const sessionPaletteCache = new Map<string, OwnerPalette>();
const pendingLoads = new Map<string, Promise<OwnerPalette>>();

function setSessionPalette(src: string, palette: OwnerPalette): void {
  if (sessionPaletteCache.size >= SESSION_HUE_MAX) {
    const oldest = sessionPaletteCache.keys().next().value;
    if (oldest !== undefined) sessionPaletteCache.delete(oldest);
  }
  sessionPaletteCache.set(src, palette);
}

export function ownerPaletteFromAvatar(src: string): Promise<OwnerPalette>;
export function ownerPaletteFromAvatar(
  src: string,
  fallbackPalette: OwnerPalette,
): Promise<OwnerPalette>;
export function ownerPaletteFromAvatar(
  src: string,
  fallbackPalette: OwnerPalette = { kind: "color", hue: hashString(src) % 360 },
): Promise<OwnerPalette> {
  if (typeof document === "undefined") return Promise.resolve(fallbackPalette);

  const session = sessionPaletteCache.get(src);
  if (session !== undefined) return Promise.resolve(session);

  const pending = pendingLoads.get(src);
  if (pending) return pending;

  const promise = paletteFromSrc(src, fallbackPalette).then((palette) => {
    setSessionPalette(src, palette);
    return palette;
  });

  pendingLoads.set(src, promise);
  promise.finally(() => pendingLoads.delete(src));
  return promise;
}

export function clearOwnerHueCache(): void {
  sessionPaletteCache.clear();
  pendingLoads.clear();
}
