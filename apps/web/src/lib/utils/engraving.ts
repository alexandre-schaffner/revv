import { hashString } from "$lib/utils/avatarPalette";
import {
  drawCabin,
  drawRock,
  drawSprig,
  drawTrack,
  drawTree,
  drawTuft,
  fenceProps,
  makeTrack,
} from "$lib/utils/engraving-land";
import {
  blade,
  brokenLine,
  clamp01,
  fbm,
  makeNoise1d,
  makeNoise2d,
  makeRng,
  pick,
  type Rng,
} from "$lib/utils/engraving-marks";
import { type Ground, makeGround, type Prop, paintProps } from "$lib/utils/engraving-props";
import { drawDistantSail, drawHeadland, drawSailboat, drawSeaRock } from "$lib/utils/engraving-sea";
import { drawDaySky, drawNightSky } from "$lib/utils/engraving-sky";

export interface EngravingInk {
  ink: string;
  paper: string;
}

export interface EngravingOptions extends EngravingInk {
  seed: string;
  width: number;
  height: number;
  textWidth: number;
  time: "day" | "night";
}

interface Ridge {
  at: (x: number) => number;
  depth: number;
  nearness: number;
}

function makeRidge(
  rng: Rng,
  width: number,
  height: number,
  base: number,
  amplitude: number,
  wavelength: number,
  nearness: number,
): Ridge {
  const noise = makeNoise1d(rng);
  const peaks = Array.from({ length: 1 + Math.floor(rng() * 2) }, () => ({
    x: width * (0.4 + rng() * 0.6),
    h: amplitude * (0.35 + rng() * 0.55),
    w: width * (0.07 + rng() * 0.09),
  }));
  const at = (x: number) => {
    let y = base - fbm(noise, x / wavelength, 5) * amplitude;
    for (const p of peaks) {
      const d = (x - p.x) / p.w;
      y -= p.h * Math.exp(-d * d);
    }
    const ceiling = height * 0.3;
    return y < ceiling ? ceiling - (ceiling - y) * 0.25 : y;
  };
  return { at, depth: base + amplitude * 0.2, nearness };
}

function sampleRidge(ridge: Ridge, width: number): number[] {
  const ys: number[] = [];
  for (let x = 0; x <= width; x += 8) ys.push(ridge.at(x));
  return ys;
}

function engraveRange(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ridge: Ridge,
  opts: EngravingOptions,
) {
  const { width, height, ink, paper } = opts;
  const step = 1.5;
  const silhouette = () => {
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width + step; x += step) ctx.lineTo(x, ridge.at(x));
    ctx.lineTo(width, height);
    ctx.closePath();
  };
  silhouette();
  ctx.fillStyle = paper;
  ctx.fill();

  const lightRise = 0.42;
  const cols = Math.ceil(width / step) + 2;
  const castDepth = new Float32Array(cols);
  let lightLine = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cols; i++) {
    const top = ridge.at(i * step);
    lightLine = Math.min(lightLine + step * lightRise, top);
    castDepth[i] = Math.max(0, top - lightLine);
  }
  const shadowReach = (x: number) => (castDepth[Math.round(x / step)] ?? 0) * 2.6;

  const summitX = (() => {
    let best = 0;
    let bestY = Number.POSITIVE_INFINITY;
    for (let x = 0; x <= width; x += 6) {
      const yy = ridge.at(x);
      if (yy < bestY) {
        bestY = yy;
        best = x;
      }
    }
    return best;
  })();
  const spurNoise = makeNoise1d(rng);
  const grainNoise = makeNoise2d(rng);
  const rockNoise = makeNoise2d(rng);
  const spurScale = 34 + ridge.nearness * 26;
  const spur = (x: number, y: number) => {
    const d = y - ridge.at(x);
    const fan = Math.max(-1, Math.min(1, (x - summitX) / (width * 0.25)));
    const u = (x + d * fan * 1.1) / spurScale;
    const n = fbm(spurNoise, u, 2);
    return 1 - Math.abs(n - 0.5) * 2;
  };
  const tone = (x: number, y: number) => {
    const d = y - ridge.at(x);
    const slope = (ridge.at(x + 3) - ridge.at(x - 3)) / 6;
    const face = Math.max(-0.3, Math.min(0.3, slope * 1.2)) * Math.exp(-d / 26);
    const sd = spur(x - 2, y) - spur(x + 2, y);
    const wedge = 0.35 + grainNoise(x / 45 + 50, d / 18) * 0.9;
    const spurShade = (sd > 0 ? Math.min(0.55, sd * 5) : Math.max(-0.2, sd * 2)) * wedge;
    const cast = d < shadowReach(x) ? 0.3 : 0;
    const grain = (grainNoise(x / 7, y / 3) - 0.5) * 0.2;
    const crest = Math.min(1, d / (3 + ridge.nearness * 3));
    const t = (0.32 + face + spurShade * Math.min(1, d / 10) + cast + grain) * crest;
    return clamp01(t) * (0.75 + ridge.nearness * 0.25);
  };

  const rock = (x: number, y: number) =>
    rockNoise(x / 18, y / 15) * 0.75 + rockNoise(x / 7, y / 8) * 0.25;

  ctx.save();
  silhouette();
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineCap = "butt";

  const weight = 0.75 + ridge.nearness * 0.3;
  const gap = 1.9 + ridge.nearness * 0.5;
  const top = Math.min(...sampleRidge(ridge, width));
  const base = ridge.depth + 3;
  const lines = Math.ceil((base - top) / gap);
  const wobble = makeNoise2d(rng);
  ctx.fillStyle = ink;
  ctx.beginPath();
  for (let k = 1; k < lines; k++) {
    const f = k / lines;
    let rank = 0;
    while (rank < 6 && (k >> rank) % 2 === 0) rank++;
    let upper: [number, number][] = [];
    let lower: [number, number][] = [];
    const flush = () => {
      if (upper.length > 1) {
        const [fx, fy] = upper[0] as [number, number];
        ctx.moveTo(fx, fy);
        for (const [px, py] of upper.slice(1)) ctx.lineTo(px, py);
        for (const [px, py] of lower.reverse()) ctx.lineTo(px, py);
        ctx.closePath();
      }
      upper = [];
      lower = [];
    };
    for (let x = 0; x <= width + step; x += step) {
      const ridgeY = ridge.at(x);
      const span = base - ridgeY;
      const spacing = span / lines;
      const fadeRank = clamp01((spacing * 2 ** (rank + 1) - gap) / gap);
      let w = 0;
      let y = 0;
      if (fadeRank > 0.05 && x <= width) {
        const d = span * f;
        const height01 = clamp01((base - ridgeY) / (base - top));
        const relax = Math.exp(-d / (6 + span * 0.28));
        const amp = (1.2 + height01 * 7) * relax;
        const yy = ridgeY + d;
        const relief = (rock(x, yy) - 0.5) * 2;
        y = yy + relief * amp + (wobble(x / 14, k * 0.7) - 0.5) * 0.9;
        const t = tone(x, y);
        w = weight * (0.15 + t * 1.75) * fadeRank;
        if (t < 0.1 || d < 0.8 || w < 0.18) w = 0;
      }
      if (w > 0) {
        upper.push([x, y - w / 2]);
        lower.push([x, y + w / 2]);
      } else {
        flush();
      }
    }
    flush();
  }
  ctx.fill();

  ctx.restore();
}

function plantPines(ctx: CanvasRenderingContext2D, rng: Rng, ridge: Ridge, opts: EngravingOptions) {
  const { width, ink } = opts;
  const stands = 1 + Math.floor(rng() * 2);
  ctx.fillStyle = ink;
  for (let s = 0; s < stands; s++) {
    const centre = width * (0.35 + rng() * 0.6);
    const spread = 30 + rng() * 70;
    const count = 5 + Math.floor(rng() * 9);
    for (let i = 0; i < count; i++) {
      const x = centre + (rng() - 0.5) * spread;
      const y = ridge.at(x) + 1 + rng() * 5;
      const h = 9 + rng() * 11 + ridge.nearness * 6;
      ctx.globalAlpha = 0.75 + ridge.nearness * 0.25;
      ctx.beginPath();
      ctx.rect(x - 0.45, y - h * 0.3, 0.9, h * 0.3 + 1);
      const tiers = 5 + Math.floor(h / 4);
      for (let t = 0; t < tiers; t++) {
        const f = t / tiers;
        const ty = y - h * 0.18 - f * h * 0.82;
        const reach = (1 - f) * h * 0.32 + 0.8;
        blade(ctx, x, ty, reach, -1.95 + rng() * 0.2, 1.4, 0);
        blade(ctx, x, ty, reach, 1.95 - rng() * 0.2, 1.4, 0);
      }
      blade(ctx, x, y - h * 0.9, h * 0.14, 0, 1.2, 0);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function engravePlain(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ground: Ground,
  opts: EngravingOptions,
) {
  const { width, height, ink, paper } = opts;
  const inks = { ink, paper };
  const { horizon, depth } = ground;
  const patchNoise = makeNoise1d(rng);

  ctx.fillStyle = ink;
  const rowCount = Math.round(depth / 2.6);
  for (let i = 0; i < rowCount; i++) {
    const t = (i + 0.5) / rowCount;
    const y = ground.yAtDepth(t);
    const dot = 0.55 + t * 0.6;
    ctx.globalAlpha = 0.45 + t * 0.4;
    ctx.beginPath();
    let x = rng() * 4;
    while (x < width) {
      const density = 0.15 + patchNoise(x / 140 + i * 0.04) * 0.7;
      const jitter = (rng() - 0.5) * (0.6 + t);
      if (rng() < density) {
        if (rng() < 0.12) {
          ctx.rect(x, y + jitter, 2 + rng() * (3 + t * 5), dot * 0.8);
        } else {
          ctx.rect(x, y + jitter, dot, dot);
        }
      }
      x += 1.8 + t * 3 + rng() * (1.5 + t * 3);
    }
    ctx.fill();
  }
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  const sprigs = Math.round((width * depth) / 260);
  for (let i = 0; i < sprigs; i++) {
    const t = rng() ** 0.8;
    const x = rng() * width;
    if (patchNoise(x / 140 + t * 3) < 0.3) continue;
    ctx.lineWidth = 0.5 + t * 0.6;
    ctx.globalAlpha = 0.55 + t * 0.35;
    ctx.beginPath();
    drawSprig(ctx, rng, x, ground.yAtDepth(0.05 + t * 0.95), 1.5 + t * 5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const track = rng() < 0.7 ? makeTrack(rng, ground) : null;
  if (track) drawTrack(ctx, rng, track, ground, inks);

  const props: Prop[] = [];
  const taken: [number, number][] = [];
  const placeX = (t: number, w: number): number | null => {
    const y = ground.yAtDepth(t);
    for (let i = 0; i < 16; i++) {
      const x = width * (0.08 + rng() * 0.86);
      if (track && [x - w / 2, x, x + w / 2].some((px) => track.covers(px, y, 6))) continue;
      if (taken.some(([a, b]) => x + w / 2 > a && x - w / 2 < b)) continue;
      taken.push([x - w / 2, x + w / 2]);
      return x;
    }
    return null;
  };
  const stand = (t: number, w: number, draw: (x: number, y: number) => void) => {
    const x = placeX(t, w);
    const y = ground.yAtDepth(t);
    if (x !== null) props.push({ y, draw: () => draw(x, y) });
  };

  const hasTree = rng() < 0.65;
  const hasCabin = rng() < 0.5 || !hasTree;
  if (hasTree) {
    const t = 0.3 + rng() * 0.25;
    const h = 34 + t * 46;
    stand(t, h * 0.8, (x, y) => drawTree(ctx, rng, x, y, h, inks));
  }
  if (hasCabin) {
    const t = 0.08 + rng() * 0.14;
    const size = 16 + t * 44;
    stand(t, size * 1.4, (x, y) => drawCabin(ctx, rng, x - size / 2, y, size, inks));
  }
  if (track && rng() < 0.6) props.push(...fenceProps(ctx, rng, track, ground, ink));
  const rocks = Math.floor(rng() * 3);
  for (let i = 0; i < rocks; i++) {
    const t = 0.5 + rng() * 0.5;
    const w = 8 + t * 22;
    stand(t, w * 1.6, (x, y) => drawRock(ctx, rng, x, y, w, inks));
  }

  const bands = 6;
  for (let b = 0; b < bands; b++) {
    const t = (b + 0.5) / bands;
    const size = 3 + t ** 1.5 * 17;
    const spacing = 16 + t * 40;
    const y0 = horizon + depth * (0.12 + 0.88 * (b / bands)) ** 1.2;
    const y1 = horizon + depth * (0.12 + 0.88 * ((b + 1) / bands)) ** 1.2;
    for (let x = rng() * spacing; x < width; x += spacing * (0.6 + rng() * 0.8)) {
      if (rng() < 0.45) continue;
      const y = y0 + rng() * (y1 - y0);
      if (track?.covers(x, y)) continue;
      const tuft = size * (0.7 + rng() * 0.6);
      props.push({ y, draw: () => drawTuft(ctx, rng, x, y, tuft, inks, t) });
      if (rng() < 0.2) {
        const nx = x + (rng() < 0.5 ? -1 : 1) * tuft * (0.7 + rng() * 0.4);
        const ny = y + (rng() - 0.5) * 1.5;
        const small = tuft * (0.5 + rng() * 0.3);
        if (!track?.covers(nx, ny)) {
          props.push({ y: ny, draw: () => drawTuft(ctx, rng, nx, ny, small, inks, t) });
        }
      }
    }
  }
  if (track) {
    for (let t = 0.15; t < 1.05; t += 0.04 + rng() * 0.06) {
      if (rng() < 0.35) continue;
      const side = rng() < 0.5 ? -1 : 1;
      const x = track.centre(t) + side * (track.half(t) + 1 + rng() * 3);
      const y = ground.yAtDepth(t);
      const tuft = 2 + t * 12;
      props.push({ y, draw: () => drawTuft(ctx, rng, x, y, tuft, inks, t) });
    }
  }
  const near = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < near; i++) {
    const x = rng() * width;
    const y = height + 2 + rng() * 6;
    const tuft = 22 + rng() * 12;
    props.push({ y, draw: () => drawTuft(ctx, rng, x, y, tuft, inks, 1) });
  }
  paintProps(props);
}

function engraveSea(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ground: Ground,
  glintX: number,
  shore: Ridge | undefined,
  opts: EngravingOptions,
) {
  const { width, height, ink, paper } = opts;
  const { horizon, depth } = ground;
  ctx.fillStyle = paper;
  ctx.fillRect(0, horizon, width, height - horizon + 1);

  const swellNoise = makeNoise2d(rng);
  const ripple = makeNoise1d(rng);
  const glintEdge = makeNoise1d(rng);
  const glintHalf = (y: number) => {
    const t = ground.depthAtY(y);
    return (7 + t * 70) * (0.6 + glintEdge(y * 0.9) * 0.8);
  };
  const inGlint = (x: number, y: number) => Math.abs(x - glintX) < glintHalf(y);

  ctx.fillStyle = ink;

  const step = 1.5;
  ctx.beginPath();
  let t = 0.02;
  while (t < 1.06) {
    const base = ground.yAtDepth(t);
    const scale = 26 + t * 70;
    const z = t * 11;
    const amp = 0.4 + t * 6.5;
    const weight = 0.45 + t * 1.6;
    const lineY = (x: number) => {
      const u = x / scale + (swellNoise(x / 260, z * 0.25 + 40) - 0.5) * 3;
      return (
        base -
        (swellNoise(u, z) - 0.5) * 2 * amp -
        (swellNoise(u * 2.3 + 9, z * 1.7) - 0.5) * amp * 0.45
      );
    };
    let top: [number, number][] = [];
    let bottom: [number, number][] = [];
    const flush = () => {
      if (top.length > 1) {
        const [fx, fy] = top[0] as [number, number];
        ctx.moveTo(fx, fy);
        for (const [px, py] of top.slice(1)) ctx.lineTo(px, py);
        for (const [px, py] of bottom.reverse()) ctx.lineTo(px, py);
        ctx.closePath();
      }
      top = [];
      bottom = [];
    };
    let prevY = lineY(-step);
    for (let x = 0; x <= width + step; x += step) {
      const y = lineY(x);
      const slope = (y - prevY) / step;
      const reach = shore ? (horizon - shore.at(x)) * 0.75 : 0;
      const mirror = reach > 0 && y - horizon < reach ? (1 - (y - horizon) / reach) * 0.45 : 0;
      const shade = clamp01(
        0.45 + mirror + slope * (2.2 / (0.4 + t)) + (ripple(x / 7 + t * 40) - 0.5) * 0.5,
      );
      const w = weight * shade * 1.6;
      const visible = w > weight * 0.35 && x <= width && !inGlint(x, y);
      if (visible) {
        top.push([x, y - w / 2]);
        bottom.push([x, y + w / 2]);
      } else {
        flush();
      }
      prevY = y;
    }
    flush();
    t += (1.4 + t * 4.2) / depth;
  }
  ctx.fill();
}

function furnishSea(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ground: Ground,
  glintX: number,
  opts: EngravingOptions,
) {
  const { width, ink, paper } = opts;
  const inks = { ink, paper };
  const sails = rng() < 0.7 ? 1 + Math.floor(rng() * 2) : 0;
  for (let i = 0; i < sails; i++) {
    drawDistantSail(
      ctx,
      width * (0.1 + rng() * 0.8),
      ground.yAtDepth(0.08 + rng() * 0.08),
      3.5 + rng() * 2.5,
      ink,
    );
  }

  const hasLighthouse = rng() < 0.55;
  const hasBoat = rng() < 0.7 || !hasLighthouse;
  const [keepFrom, keepTo] = hasLighthouse ? drawHeadland(ctx, rng, ground, inks) : [-1, -1];
  const clear = (x: number, w: number) => x + w / 2 < keepFrom || x - w / 2 > keepTo;
  const freeX = (w: number) => {
    for (let i = 0; i < 12; i++) {
      const x = width * (0.1 + rng() * 0.8);
      if (clear(x, w)) return x;
    }
    return null;
  };

  const props: Prop[] = [];
  if (hasBoat) {
    const t = 0.25 + rng() * 0.3;
    const h = 22 + t * 34;
    const inGlint = rng() < 0.35 && clear(glintX, h);
    const x = inGlint ? glintX : freeX(h);
    const y = ground.yAtDepth(t);
    if (x !== null) props.push({ y, draw: () => drawSailboat(ctx, x, y, h, inks) });
  }
  const rocks = rng() < 0.5 ? 1 + Math.floor(rng() * 2) : 0;
  for (let i = 0; i < rocks; i++) {
    const t = 0.4 + rng() * 0.55;
    const w = 6 + t * 16;
    const x = freeX(w * 2);
    const y = ground.yAtDepth(t);
    if (x !== null) props.push({ y, draw: () => drawSeaRock(ctx, rng, x, y, w, inks) });
  }
  paintProps(props);
}

function grain(ctx: CanvasRenderingContext2D, rng: Rng, opts: EngravingOptions) {
  const { width, height, ink, paper } = opts;
  const count = Math.round((width * height) / 30);
  for (const [colour, alpha] of [
    [paper, 0.08],
    [ink, 0.1],
  ] as const) {
    ctx.fillStyle = colour;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < count / 2; i++) {
      const s = rng() < 0.85 ? 0.8 : 1.4;
      ctx.rect(rng() * width, rng() * height, s, s);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

type Foreground = "plain" | "sea";

const SKY_STREAM_SALT = 0x5bd1e995;

function landStream(seed: string): Rng {
  return makeRng(hashString(seed) || 1);
}

function skyStream(seed: string): Rng {
  return makeRng((hashString(seed) ^ SKY_STREAM_SALT) >>> 0 || 2);
}

export function drawEngraving(
  canvas: HTMLCanvasElement,
  opts: EngravingOptions,
  devicePixelRatio: number,
): void {
  canvas.width = Math.round(opts.width * devicePixelRatio);
  canvas.height = Math.round(opts.height * devicePixelRatio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  engrave(ctx, opts);
}

function engrave(ctx: CanvasRenderingContext2D, opts: EngravingOptions): void {
  const { width, height, ink } = opts;
  const rng = landStream(opts.seed);
  const foreground = pick<Foreground>(rng, ["plain", "plain", "sea"]);
  const pines = rng() < 0.45;

  const day = opts.time === "day";
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = day ? opts.paper : ink;
  ctx.fillRect(0, 0, width, height);

  const ranges: Ridge[] =
    foreground === "sea"
      ? [
          makeRidge(rng, width, height, height * 0.6, height * 0.2, 190, 0),
          makeRidge(rng, width, height, height * 0.66, height * 0.11, 110, 0.5),
        ]
      : [
          makeRidge(rng, width, height, height * 0.6, height * 0.2, 190, 0),
          makeRidge(rng, width, height, height * 0.67, height * 0.12, 120, 0.5),
          makeRidge(rng, width, height, height * 0.72, height * 0.05, 80, 1),
        ];
  const skyline = Math.min(...ranges.flatMap((r) => sampleRidge(r, width)));

  const skyRng = skyStream(opts.seed);
  const body = day
    ? drawDaySky(ctx, skyRng, skyline, opts)
    : drawNightSky(ctx, skyRng, skyline, ranges[0]?.at, opts);
  for (const [i, range] of ranges.entries()) {
    engraveRange(ctx, rng, range, opts);
    if (day && i === 0) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.9;
      ctx.lineCap = "round";
      const broken = makeNoise1d(skyRng);
      brokenLine(ctx, 0, width, 1.5, range.at, (x) => broken(x / 6) > 0.12);
    }
    if (pines && i === 1) plantPines(ctx, rng, range, opts);
  }
  const last = ranges[ranges.length - 1];
  const ground = makeGround(last ? last.depth : height * 0.78, width, height);
  if (foreground === "sea") {
    engraveSea(ctx, rng, ground, body.x, last, opts);
    furnishSea(ctx, rng, ground, body.x, opts);
  } else {
    engravePlain(ctx, rng, ground, opts);
  }
  grain(ctx, rng, opts);
}
