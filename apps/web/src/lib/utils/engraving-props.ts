import { clamp01, type Rng } from "$lib/utils/engraving-marks";

export interface Inks {
  ink: string;
  paper: string;
}

export interface Ground {
  horizon: number;
  depth: number;
  width: number;
  height: number;
  yAtDepth: (t: number) => number;
  depthAtY: (y: number) => number;
}

const PERSPECTIVE = 1.45;

export function makeGround(horizon: number, width: number, height: number): Ground {
  const depth = height - horizon;
  return {
    horizon,
    depth,
    width,
    height,
    yAtDepth: (t) => horizon + depth * Math.max(0, t) ** PERSPECTIVE,
    depthAtY: (y) => clamp01((y - horizon) / depth) ** (1 / PERSPECTIVE),
  };
}

export interface Prop {
  y: number;
  draw: () => void;
}

export function paintProps(props: Prop[]) {
  for (const prop of props.sort((a, b) => a.y - b.y)) prop.draw();
}

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
