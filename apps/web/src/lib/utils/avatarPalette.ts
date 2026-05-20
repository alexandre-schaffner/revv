// Owner hue extraction from GitHub avatars.
//
// Owner GitHub avatars are fetched once, stored as data URLs in localStorage,
// and loaded from there on every subsequent visit — no network request needed.
// On each mount a background refresh re-fetches from GitHub and silently
// updates the cache so stale avatars self-correct over time.
//
// Hue extraction runs on-demand from the cached image via the Canvas API.
// A session-level cache (Map) deduplicates within-session extractions so
// 20 avatars from the same owner only ever process one image per page load.

// ── Hash (fallback) ───────────────────────────────────────────────────────────

export function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function fallbackOwnerHue(repoFullName: string): number {
  const owner = (repoFullName.split("/")[0] ?? repoFullName).toLowerCase();
  return hashString(owner) % 360;
}

// ── Image cache (localStorage) ────────────────────────────────────────────────

const LS_PREFIX = "revv:avatar-img:";

function readImageCache(url: string): string | null {
  try {
    return localStorage.getItem(LS_PREFIX + url);
  } catch {
    return null;
  }
}

function writeImageCache(url: string, dataUrl: string): void {
  try {
    localStorage.setItem(LS_PREFIX + url, dataUrl);
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

// Fetch the avatar from the network, draw it to a 32×32 canvas, and return
// a PNG data URL. The ?s=32 param requests a small image and ensures a URL
// distinct from the display <img> (which may be cached without CORS headers).
function fetchToDataUrl(avatarUrl: string): Promise<string> {
  const src = avatarUrl.includes("?") ? `${avatarUrl}&s=32` : `${avatarUrl}?s=32`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("no 2d ctx"));
          return;
        }
        ctx.drawImage(img, 0, 0, 32, 32);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

// ── Hue extraction ────────────────────────────────────────────────────────────

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

function hueFromImg(img: HTMLImageElement): number {
  const SIZE = 16;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return hashString(img.src) % 360;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  const weighted: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a < 128) continue;
    const [h, s, l] = rgbToHsl(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    if (s < 0.15 || l < 0.1 || l > 0.92) continue;
    const weight = Math.round(s * 4) + 1;
    for (let w = 0; w < weight; w++) weighted.push(h);
  }

  if (weighted.length === 0) return hashString(img.src) % 360;
  weighted.sort((a, b) => a - b);
  return weighted[Math.floor(weighted.length / 2)] ?? 0;
}

function hueFromDataUrl(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        resolve(hueFromImg(img));
      } catch {
        resolve(hashString(dataUrl) % 360);
      }
    };
    img.onerror = () => resolve(hashString(dataUrl) % 360);
    img.src = dataUrl;
  });
}

// ── Session dedup + pending map ───────────────────────────────────────────────

const sessionHueCache = new Map<string, number>();
const pendingLoads = new Map<string, Promise<number>>();
const refreshed = new Set<string>(); // prevents duplicate background refreshes

function backgroundRefresh(avatarUrl: string): void {
  if (refreshed.has(avatarUrl)) return;
  refreshed.add(avatarUrl);
  fetchToDataUrl(avatarUrl)
    .then((dataUrl) => {
      writeImageCache(avatarUrl, dataUrl);
      return hueFromDataUrl(dataUrl);
    })
    .then((hue) => {
      sessionHueCache.set(avatarUrl, hue);
    })
    .catch(() => {
      // Network failure — cached image stays as-is.
    });
}

export function ownerHueFromAvatar(avatarUrl: string): Promise<number> {
  if (typeof document === "undefined") {
    return Promise.resolve(hashString(avatarUrl) % 360);
  }

  const session = sessionHueCache.get(avatarUrl);
  if (session !== undefined) return Promise.resolve(session);

  const pending = pendingLoads.get(avatarUrl);
  if (pending) return pending;

  const promise = (async () => {
    const cached = readImageCache(avatarUrl);
    if (cached) {
      const hue = await hueFromDataUrl(cached);
      sessionHueCache.set(avatarUrl, hue);
      backgroundRefresh(avatarUrl); // keep cache fresh, non-blocking
      return hue;
    }

    // First visit: fetch from network, store, extract.
    try {
      const dataUrl = await fetchToDataUrl(avatarUrl);
      writeImageCache(avatarUrl, dataUrl);
      const hue = await hueFromDataUrl(dataUrl);
      sessionHueCache.set(avatarUrl, hue);
      return hue;
    } catch {
      const h = hashString(avatarUrl) % 360;
      sessionHueCache.set(avatarUrl, h);
      return h;
    }
  })();

  pendingLoads.set(avatarUrl, promise);
  promise.finally(() => pendingLoads.delete(avatarUrl));
  return promise;
}
