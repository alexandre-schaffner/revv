export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, options: readonly T[]): T {
  return options[Math.floor(rng() * options.length)] as T;
}

export function makeNoise1d(rng: Rng): (x: number) => number {
  const lattice = Array.from({ length: 512 }, rng);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = lattice[((i % 512) + 512) % 512] ?? 0;
    const b = lattice[(((i + 1) % 512) + 512) % 512] ?? 0;
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

export function makeNoise2d(rng: Rng): (x: number, y: number) => number {
  const size = 256;
  const perm = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j] ?? 0, perm[i] ?? 0];
  }
  const values = Float32Array.from({ length: size }, rng);
  const at = (i: number, j: number) => values[((perm[i & 255] ?? 0) + (j & 255)) & 255] ?? 0;
  return (x, y) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = at(i, j);
    const b = at(i + 1, j);
    const c = at(i, j + 1);
    const d = at(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

export function fbm(noise: (x: number) => number, x: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq + o * 37.1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function brokenLine(
  ctx: CanvasRenderingContext2D,
  from: number,
  to: number,
  step: number,
  y: (x: number) => number,
  on: (x: number) => boolean,
) {
  ctx.beginPath();
  let drawing = false;
  for (let x = from; x <= to; x += step) {
    const ink = on(x);
    if (ink && !drawing) ctx.moveTo(x, y(x));
    else if (ink) ctx.lineTo(x, y(x));
    drawing = ink;
  }
  ctx.stroke();
}

export function blade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  angle: number,
  baseWidth: number,
  bend: number,
) {
  const tipX = x + Math.sin(angle) * length + bend;
  const tipY = y - Math.cos(angle) * length;
  const midX = x + Math.sin(angle) * length * 0.5 + bend * 0.25;
  const midY = y - Math.cos(angle) * length * 0.55;
  const nx = Math.cos(angle) * baseWidth * 0.5;
  const ny = Math.sin(angle) * baseWidth * 0.5;
  ctx.moveTo(x - nx, y - ny);
  ctx.quadraticCurveTo(midX - nx * 0.5, midY - ny * 0.5, tipX, tipY);
  ctx.quadraticCurveTo(midX + nx * 0.5, midY + ny * 0.5, x + nx, y + ny);
  ctx.closePath();
}

export function hatchClip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  gap: number,
  angle: number,
) {
  const reach = w + h;
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  ctx.beginPath();
  for (let o = -reach; o < reach; o += gap) {
    const cx = x + w / 2 - Math.sin(angle) * o;
    const cy = y + h / 2 + Math.cos(angle) * o;
    ctx.moveTo(cx - dx, cy - dy);
    ctx.lineTo(cx + dx, cy + dy);
  }
  ctx.stroke();
}
