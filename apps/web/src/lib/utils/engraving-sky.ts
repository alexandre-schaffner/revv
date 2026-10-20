// The engraved plate's sky, by night and by day (`engraving.ts` picks one
// per theme). Each draws from the sky's own random stream, never the
// landscape's, so a plate's day and night share one landscape.

import type { EngravingOptions } from "$lib/utils/engraving";
import { blade, makeNoise1d, makeNoise2d, type Rng } from "$lib/utils/engraving-marks";

interface SkyBody {
  x: number;
  y: number;
}

/** Where a sky's moon or sun and its birds may go, and where they mustn't. */
interface SkyFrame {
  left: number;
  right: number;
  /** The moon's or sun's x. */
  cx: number;
  clearOfText: (x: number, y: number) => boolean;
}

/** The band between the hero's text on the left and its action button on the right. */
function skyFrame(rng: Rng, opts: EngravingOptions): SkyFrame {
  const { width, height, textWidth } = opts;
  const left = Math.min(textWidth, width * 0.6);
  const right = width - Math.min(150, width * 0.2);
  const cx = left + (right - left) * (0.1 + rng() * 0.8);
  const clearOfText = (x: number, y: number) => x > textWidth + 56 || y > height * 0.45;
  return { left, right, cx, clearOfText };
}

/** A few birds crossing, as ticks in whatever stroke is set. */
function drawBirds(ctx: CanvasRenderingContext2D, rng: Rng, frame: SkyFrame, height: number) {
  const { left, right, clearOfText } = frame;
  const fx = left + 56 + rng() * Math.max(0, right - left - 56);
  const fy = height * (0.2 + rng() * 0.18);
  const birds = 3 + Math.floor(rng() * 4);
  ctx.beginPath();
  for (let i = 0; i < birds; i++) {
    const bx = fx + i * (9 + rng() * 6);
    const by = fy + (rng() - 0.3) * 10 + i * 1.5;
    if (!clearOfText(bx, by)) continue;
    const s = 2.2 + rng() * 1.8;
    ctx.moveTo(bx - s, by - s * 0.3);
    ctx.quadraticCurveTo(bx - s * 0.4, by - s * 0.7, bx, by);
    ctx.quadraticCurveTo(bx + s * 0.4, by - s * 0.7, bx + s, by - s * 0.3);
  }
  ctx.stroke();
}

/** The night sky: a crescent moon with a scatter of stars. The sun is the day sky's. */
export function drawNightSky(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  skyline: number,
  /** The far range's ridge line, where the horizon glow gathers; the skyline without one. */
  farRidge: ((x: number) => number) | undefined,
  opts: EngravingOptions,
): SkyBody {
  const { width, height, ink, paper } = opts;
  const frame = skyFrame(rng, opts);
  const { left, right, cx, clearOfText } = frame;
  const cy = Math.max(height * 0.14, Math.min(skyline - 24, height * (0.16 + rng() * 0.16)));

  // Horizon glow: paper stipple that thickens toward the ranges, the way an
  // aquatint sky lightens at the skyline.
  ctx.fillStyle = paper;
  const glow = Math.round(width * 1.1);
  for (let i = 0; i < glow; i++) {
    const d = rng() ** 2.2 * 40;
    const x = rng() * width;
    const ground = farRidge ? farRidge(x) : skyline;
    ctx.globalAlpha = 0.15 + (1 - d / 40) * 0.35;
    ctx.beginPath();
    ctx.arc(x, ground + 2 - d, 0.55 + rng() * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  // Cloud bands: short runs of tapered paper lines, stacked loosely.
  const bands = 2 + Math.floor(rng() * 3);
  ctx.strokeStyle = paper;
  ctx.lineCap = "round";
  for (let b = 0; b < bands; b++) {
    const bx = left + rng() * (width - left) * 0.85;
    const by = height * (0.1 + rng() * 0.25);
    if (!clearOfText(bx - 24, by)) continue;
    const lines = 3 + Math.floor(rng() * 4);
    for (let l = 0; l < lines; l++) {
      const len = 30 + rng() * 120 * (1 - Math.abs(l - lines / 2) / lines);
      const x0 = bx + (rng() - 0.5) * 40;
      const y = by + l * 2.6;
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = 0.22 + rng() * 0.16;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + len, y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Stars, then the crescent moon.
  const stars = Math.round(width / 24);
  ctx.fillStyle = paper;
  for (let i = 0; i < stars; i++) {
    const sx = rng() * width;
    const sy = rng() * (skyline - 30);
    if (!clearOfText(sx, sy)) continue;
    ctx.globalAlpha = 0.3 + rng() * 0.6;
    ctx.beginPath();
    ctx.arc(sx, sy, rng() < 0.12 ? 1.1 : 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const r = 8 + rng() * 5;
  ctx.fillStyle = paper;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(cx + r * 0.45, cy - r * 0.3, r * 0.9, 0, Math.PI * 2);
  ctx.fill();

  // Sometimes a shooting star, its tail a long tapered blade of paper.
  if (rng() < 0.35) {
    const sx = left + 60 + rng() * Math.max(0, right - left - 120);
    const sy = height * (0.08 + rng() * 0.12);
    if (clearOfText(sx, sy) && Math.hypot(sx - cx, sy - cy) > 40) {
      ctx.fillStyle = paper;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      blade(ctx, sx, sy, 34 + rng() * 30, (rng() < 0.5 ? 1 : -1) * (1.05 + rng() * 0.3), 1.6, 0);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Now and then, a few birds crossing.
  if (rng() < 0.6) {
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    drawBirds(ctx, rng, frame, height);
    ctx.globalAlpha = 1;
  }

  return { x: cx, y: cy };
}

/**
 * A daytime sky in stipple: paper dotted like an aquatint, densest at the
 * top of the plate and thinning toward the horizon, left bare where the sun
 * and clouds are and around the hero's title, so it sits on clear paper. Clouds are cumulus heaps with
 * scalloped ink tops and hatched undersides; the sun is a ringed disc with
 * short rays.
 */
export function drawDaySky(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  skyline: number,
  opts: EngravingOptions,
): SkyBody {
  const { width, height, ink, textWidth } = opts;
  const frame = skyFrame(rng, opts);
  const { left, cx, clearOfText } = frame;
  const cy = Math.max(height * 0.16, Math.min(skyline - 26, height * (0.18 + rng() * 0.14)));
  const sunR = 11 + rng() * 5;
  const edge = makeNoise1d(rng);

  // Clouds: drifts of lumps on a flat base, their tops ragged with noise.
  // A cloud is simply where the stipple stops; no outline, which would make
  // it a cartoon.
  interface Lump {
    x: number;
    y: number;
    r: number;
  }
  const clouds: { lumps: Lump[]; base: number; x0: number; x1: number }[] = [];
  const count = 1 + Math.floor(rng() * 3);
  for (let c = 0; c < count; c++) {
    const w = 60 + rng() * 110;
    const bx = left + 40 + rng() * Math.max(0, width - left - w - 60);
    const base = height * (0.18 + rng() * 0.2);
    if (!clearOfText(bx, base) || Math.abs(bx + w / 2 - cx) < w / 2 + sunR + 10) continue;
    const lumps: Lump[] = [];
    const n = 5 + Math.floor(w / 14);
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const r = (3 + rng() * 6) * (0.5 + Math.sin(f * Math.PI) * 0.9);
      lumps.push({ x: bx + f * w + (rng() - 0.5) * 6, y: base - r * 0.5, r });
    }
    clouds.push({ lumps, base, x0: bx - 6, x1: bx + w + 8 });
  }
  const cloudAt = (x: number, y: number) =>
    clouds.find(
      (c) =>
        x > c.x0 &&
        x < c.x1 &&
        y < c.base + 0.5 &&
        c.lumps.some((l) => {
          const r = l.r * (0.85 + edge(x / 3 + l.x) * 0.35);
          return (x - l.x) ** 2 + (y - l.y) ** 2 < r * r || (y > l.y && Math.abs(x - l.x) < r);
        }),
    );

  // The stippled sky: an aquatint of dots, densest at the top of the plate
  // and thinning to bare paper at the horizon, mottled so it never reads as
  // a flat screen. Clouds, the sun and the title are where it stays bare.
  ctx.fillStyle = ink;
  ctx.beginPath();
  const mottle = makeNoise2d(rng);
  const dots = Math.round((width * skyline) / 1.3);
  for (let i = 0; i < dots; i++) {
    const x = rng() * width;
    const y = rng() * skyline;
    const depth = y / skyline;
    const grain = 0.7 + mottle(x / 45, y / 18) * 0.6;
    const density = (1 - depth) ** 1.8 * 0.62 * grain;
    if (rng() > density) continue;
    const tx = x / (textWidth + 60);
    const ty = y / (height * 0.46);
    const r = tx * tx + ty * ty;
    if (r < 0.8 || (r < 1.25 && edge(x / 3 + y * 5) < (1.25 - r) / 0.45)) continue;
    if (Math.hypot(x - cx, y - cy) < sunR + 5 || cloudAt(x, y)) continue;
    const size = 0.5 + rng() * 0.4;
    ctx.rect(x, y, size, size);
  }
  ctx.fill();

  // The sun: a fine ring in its clearing, the lower half engraved.
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
  for (let y = cy + sunR * 0.2; y < cy + sunR; y += 2.2) {
    const half = Math.sqrt(Math.max(0, sunR * sunR - (y - cy) ** 2));
    ctx.moveTo(cx - half, y);
    ctx.lineTo(cx + half, y);
  }
  ctx.stroke();

  // Birds, in ink by day.
  if (rng() < 0.6) {
    ctx.lineWidth = 0.9;
    drawBirds(ctx, rng, frame, height);
  }
  return { x: cx, y: cy };
}
