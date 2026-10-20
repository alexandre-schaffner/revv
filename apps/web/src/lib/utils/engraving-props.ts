// The ground an engraved landscape's props stand on: the foreground plane in
// perspective, the far-to-near painting order, and the cast shadow every
// standing thing shares. The props themselves live in `engraving-land.ts`
// (grass, a path and its fence, a lone tree, a cabin, boulders) and
// `engraving-sea.ts` (sailboats, sea rocks, a lighthouse on its headland).
// Each is drawn at a ground position and a size the caller derives from
// perspective (`Ground`), in the plate's two colours.
//
// Light comes from the upper left everywhere, as on the ranges: lit faces
// stay paper, the right-hand faces take the hatching, shadows fall right.

import { clamp01, type Rng } from "$lib/utils/engraving-marks";

export interface Inks {
  ink: string;
  paper: string;
}

/** The foreground plane in perspective: depth `t` runs 0 at the horizon to 1 at the plate's foot. */
export interface Ground {
  horizon: number;
  depth: number;
  width: number;
  height: number;
  y: (t: number) => number;
  t: (y: number) => number;
}

/** Rows bunch toward the horizon at this power; everything in the foreground shares it. */
const PERSPECTIVE = 1.45;

export function makeGround(horizon: number, width: number, height: number): Ground {
  const depth = height - horizon;
  return {
    horizon,
    depth,
    width,
    height,
    y: (t) => horizon + depth * Math.max(0, t) ** PERSPECTIVE,
    t: (y) => clamp01((y - horizon) / depth) ** (1 / PERSPECTIVE),
  };
}

/** Something drawn standing on the ground; props are painted far to near by `y`. */
export interface Prop {
  y: number;
  draw: () => void;
}

export function paintProps(props: Prop[]) {
  for (const prop of props.sort((a, b) => a.y - b.y)) prop.draw();
}

// ── Shadows ──────────────────────────────────────────────────────────────

/**
 * A shadow lying on the ground, projected right (away from the upper-left
 * light) by `outline`. Hatched in horizontal strokes that are heaviest at
 * the contact (`ox`, `oy`) and thin and break up toward the far end, with a
 * dark sliver right at the foot so the object sits on the ground rather than
 * floating above its shadow.
 */
export function groundShadow(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ox: number,
  oy: number,
  reach: number,
  footWidth: number,
  ink: string,
  outline: () => void,
) {
  const levels = 3;
  const buckets: number[][] = Array.from({ length: levels }, () => []);
  for (let yy = oy - reach * 0.3; yy <= oy + reach * 0.3; yy += 0.95) {
    let xx = ox - footWidth;
    while (xx < ox + reach + 4) {
      const len = 3 + rng() * 5;
      const d = clamp01((xx - ox) / reach);
      if (rng() > d * d * 0.6) {
        buckets[Math.min(levels - 1, Math.floor(d * levels))]?.push(xx, yy, xx + len);
      }
      xx += len + 0.3 + d * 1.8 * rng();
    }
  }
  ctx.save();
  ctx.beginPath();
  outline();
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.95;
  for (const [level, segs] of buckets.entries()) {
    ctx.lineWidth = 1.05 - level * 0.22;
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 3) {
      ctx.moveTo(segs[i] ?? 0, segs[i + 1] ?? 0);
      ctx.lineTo(segs[i + 2] ?? 0, segs[i + 1] ?? 0);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.ellipse(ox + footWidth * 0.1, oy + 0.4, footWidth * 0.6, 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
}
