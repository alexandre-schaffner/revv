// What stands in an engraved landscape: grass, a path and its fence, a lone
// tree, a cabin, boulders; on the water, sailboats and a lighthouse on its
// headland. Each is drawn at a ground position and a size the caller derives
// from perspective (`Ground`), in the plate's two colours.
//
// Light comes from the upper left everywhere, as on the ranges: lit faces
// stay paper, the right-hand faces take the hatching, shadows fall right.

import { blade, clamp01, hatchClip, makeNoise1d, type Rng } from "$lib/utils/engraving-marks";

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

// ── Grass ────────────────────────────────────────────────────────────────

/**
 * A blade that curls at its tip: a tapered body bent along a quadratic, the
 * last stretch hooking over. Adds to the current path; the caller fills.
 */
function curledBlade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  angle: number,
  baseWidth: number,
  curl: number,
) {
  // Spine: from the root, rising along `angle`, then bending by `curl`.
  const steps = 7;
  const spine: [number, number][] = [];
  let a = angle;
  let px = x;
  let py = y;
  for (let i = 0; i <= steps; i++) {
    spine.push([px, py]);
    const f = i / steps;
    a += curl * f * 0.35;
    px += Math.sin(a) * (length / steps);
    py -= Math.cos(a) * (length / steps);
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const [sx, sy] = spine[i] as [number, number];
    const [nx, ny] = spine[Math.min(steps, i + 1)] as [number, number];
    const [bx, by] = spine[Math.max(0, i - 1)] as [number, number];
    const dx = nx - bx;
    const dy = ny - by;
    const len = Math.hypot(dx, dy) || 1;
    const w = (baseWidth / 2) * (1 - i / steps) ** 0.8;
    left.push([sx - (dy / len) * w, sy + (dx / len) * w]);
    right.push([sx + (dy / len) * w, sy - (dx / len) * w]);
  }
  ctx.moveTo((left[0] as [number, number])[0], (left[0] as [number, number])[1]);
  for (const [lx, ly] of left.slice(1)) ctx.lineTo(lx, ly);
  for (const [rx, ry] of right.reverse()) ctx.lineTo(rx, ry);
  ctx.closePath();
}

/**
 * A tussock drawn the way an engraver cuts one, in two colours that work
 * against each other: blades crowd up out of the root so densely that their
 * thick lower halves merge into one ink mass, then thin, part and curl over
 * at the top; paper blades are cut back up through the mass, and a few ink
 * blades are laid over the cuts, so the clump has light inside its dark
 * rather than being a flat silhouette.
 */
export function drawTuft(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  size: number,
  { ink, paper }: Inks,
  near: number,
) {
  const lean = (rng() - 0.5) * 0.5;
  const weight = Math.max(0.85, size * 0.075);
  const spread = size * (0.75 + rng() * 0.35);
  // Roots crowd the middle of the clump.
  const rootX = () => x + (rng() + rng() + rng() - 1.5) * spread * 0.32;
  // Pure two colours, like the plate: no half-tones from overlapping alpha.
  const alpha = near < 0.25 ? 0.9 : 1;

  const inkBlades = (count: number, lenScale: number, widthScale: number, rise: number) => {
    for (let b = 0; b < count; b++) {
      const bx = rootX();
      const side = (bx - x) / spread;
      // Mostly upright; the outer blades lean out further and curl over.
      const angle = lean + side * 1.6 + (rng() - 0.5) * 0.45;
      const tall = 1 - Math.min(1, Math.abs(side) * 1.6);
      const len = size * lenScale * (0.5 + tall * 0.5) * (0.75 + rng() * 0.5);
      const curl =
        Math.sign(side || rng() - 0.5) * (0.6 + rng() * 1.6) * (0.4 + Math.abs(side) * 2);
      curledBlade(ctx, bx, y - rise, len, angle, weight * widthScale * (0.8 + rng() * 0.5), curl);
    }
  };

  // Back blades, then the body of the clump.
  ctx.globalAlpha = alpha;
  ctx.fillStyle = ink;
  ctx.beginPath();
  inkBlades(10 + Math.floor(near * 14), 1, 0.9, 0);
  inkBlades(12 + Math.floor(near * 18), 0.68, 1.35, -0.4);
  // The root, buried: a low mound joining the blades' feet.
  ctx.ellipse(x, y, spread * 0.36, Math.max(0.8, size * 0.09), 0, Math.PI, 0);
  ctx.fill();

  if (size > 5) {
    // Paper cuts rising from inside the mass.
    ctx.globalAlpha = 1;
    ctx.fillStyle = paper;
    ctx.beginPath();
    const cuts = 4 + Math.floor(size * 0.5 + near * 8);
    for (let c = 0; c < cuts; c++) {
      const bx = rootX();
      const side = (bx - x) / spread;
      const angle = lean + side * 1.5 + (rng() - 0.5) * 0.4;
      curledBlade(
        ctx,
        bx,
        y - size * 0.06,
        size * (0.45 + rng() * 0.4),
        angle,
        Math.max(0.55, weight * 0.5),
        side * 1.8 + (rng() - 0.5) * 0.6,
      );
    }
    ctx.fill();

    // A few ink blades in front of the cuts, so the light sits between
    // blades rather than on top of them.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ink;
    ctx.beginPath();
    inkBlades(1 + Math.floor(near * 3), 0.5, 0.8, -0.6);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * A sprig: the grass between the tufts jotted the way a hand would, two to
 * four little hooks leaning together like a scrawled word.
 */
export function drawSprig(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  size: number,
) {
  const flicks = 2 + Math.floor(rng() * 3);
  const lean = (rng() - 0.4) * 0.9;
  let fx = x;
  for (let i = 0; i < flicks; i++) {
    const h = size * (0.5 + rng() * 0.6);
    const hook = (rng() < 0.5 ? 1 : -1) * size * (0.2 + rng() * 0.25);
    ctx.moveTo(fx, y);
    ctx.bezierCurveTo(
      fx + lean * h * 0.3,
      y - h * 0.7,
      fx + lean * h + hook * 0.4,
      y - h,
      fx + lean * h + hook,
      y - h * 0.75,
    );
    fx += size * (0.3 + rng() * 0.35);
  }
}

/**
 * A shadow lying on the ground, projected right (away from the upper-left
 * light) by `outline`. Hatched in horizontal strokes that are heaviest at
 * the contact (`ox`, `oy`) and thin and break up toward the far end, with a
 * dark sliver right at the foot so the object sits on the ground rather than
 * floating above its shadow.
 */
function groundShadow(
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

// ── Path and fence ───────────────────────────────────────────────────────

export interface Track {
  centre: (t: number) => number;
  half: (t: number) => number;
  /** Whether (x, y) is on the track, with `margin` px to spare. */
  covers: (x: number, y: number, margin?: number) => boolean;
}

/** A dirt track winding from the horizon down to the viewer's feet. */
export function makeTrack(rng: Rng, ground: Ground): Track {
  const { width } = ground;
  const vanish = width * (0.45 + rng() * 0.4);
  const foot = Math.min(width * 0.85, Math.max(width * 0.15, vanish + (rng() - 0.5) * width * 0.6));
  const phase = rng() * Math.PI * 2;
  const wiggle = width * 0.05;
  const centre = (t: number) =>
    vanish + (foot - vanish) * t ** 1.2 + Math.sin(t * 4 + phase) * wiggle * t;
  const half = (t: number) => 0.8 + 46 * Math.max(0, t) ** 1.5;
  return {
    centre,
    half,
    covers: (x, y, margin = 2) => {
      const t = ground.t(y);
      return Math.abs(x - centre(t)) < half(t) + margin;
    },
  };
}

export function drawTrack(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  track: Track,
  ground: Ground,
  { ink, paper }: Inks,
) {
  const steps = 90;
  const ts = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * 1.08);
  const edge = (t: number, side: -1 | 1) => track.centre(t) + side * track.half(t);

  // Bare earth: clear the plain's rows where the track runs.
  ctx.fillStyle = paper;
  ctx.beginPath();
  for (const [i, t] of ts.entries()) {
    if (i === 0) ctx.moveTo(edge(t, -1), ground.y(t));
    else ctx.lineTo(edge(t, -1), ground.y(t));
  }
  for (const t of [...ts].reverse()) ctx.lineTo(edge(t, 1), ground.y(t));
  ctx.closePath();
  ctx.fill();

  const noise = makeNoise1d(rng);
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  // Wheel ruts, then the verges.
  for (const [offset, alpha, weight] of [
    [-0.45, 0.6, 0.6],
    [0.45, 0.6, 0.6],
    [-1, 1, 1.2],
    [1, 1, 1.2],
  ] as const) {
    ctx.globalAlpha = alpha;
    let drawing = false;
    for (const t of ts) {
      if (t < 0.06) continue;
      const on = noise(t * 30 + offset * 7) > (offset === -1 || offset === 1 ? 0.18 : 0.32);
      const x = track.centre(t) + offset * track.half(t);
      const y = ground.y(t);
      ctx.lineWidth = weight * (0.6 + t * 1.1);
      if (on && !drawing) {
        ctx.beginPath();
        ctx.moveTo(x, y);
      } else if (on) {
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
      drawing = on;
    }
  }
  // A few stones and dashes on the surface.
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 0; i < 40; i++) {
    const t = 0.15 + rng() * 0.9;
    const x = track.centre(t) + (rng() - 0.5) * track.half(t) * 1.4;
    const y = ground.y(t);
    const len = 1 + t * 5 * rng();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Fence posts down one verge of the track, strung with two sagging wires. */
export function fenceProps(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  track: Track,
  ground: Ground,
  ink: string,
): Prop[] {
  const side = rng() < 0.5 ? -1 : 1;
  const posts: { x: number; y: number; h: number; w: number }[] = [];
  for (let t = 0.1 + rng() * 0.05; t < 1.15; t *= 1.22) {
    posts.push({
      x: track.centre(t) + side * (track.half(t) + 4 + t * 18),
      y: ground.y(t),
      h: 2.5 + t * 22,
      w: 0.7 + t * 2.2,
    });
  }
  return posts.map((post, i) => ({
    y: post.y,
    draw: () => {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(post.x - post.w / 2, post.y + 0.5);
      ctx.lineTo(post.x - post.w * 0.4, post.y - post.h);
      ctx.lineTo(post.x + post.w * 0.4, post.y - post.h - post.w * 0.3);
      ctx.lineTo(post.x + post.w / 2, post.y + 0.5);
      ctx.closePath();
      ctx.fill();
      const prev = posts[i - 1];
      if (!prev) return;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.45 + (post.h / 24) * 0.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (const f of [0.38, 0.78]) {
        const y0 = prev.y - prev.h * f;
        const y1 = post.y - post.h * f;
        ctx.moveTo(prev.x, y0);
        ctx.quadraticCurveTo(
          (prev.x + post.x) / 2,
          (y0 + y1) / 2 + 0.6 + post.h * 0.06,
          post.x,
          y1,
        );
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    },
  }));
}

// ── Tree, cabin, rocks ───────────────────────────────────────────────────

/** A lone broadleaf: tapered trunk, a crown of massed lumps lit from the upper left. */
export function drawTree(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  h: number,
  { ink, paper }: Inks,
) {
  const lean = (rng() - 0.5) * h * 0.1;
  const crownY = y - h * 0.58;
  const bw = Math.max(1.6, h * 0.06);
  // The low light throws the trunk's shadow out along the ground and the
  // crown's after it, a pool beyond a thin stem.
  const th = Math.max(2.5, h * 0.1);
  groundShadow(ctx, rng, x, y, h * 1.1, bw * 2.2, ink, () => {
    ctx.moveTo(x - bw, y - 0.4);
    ctx.lineTo(x + h * 0.52, y + th * 0.25);
    ctx.lineTo(x + h * 0.52, y + th * 1.1);
    ctx.lineTo(x + bw, y + 0.8);
    ctx.closePath();
    ctx.moveTo(x + h * 1.14, y + th * 0.75);
    ctx.ellipse(x + h * 0.8, y + th * 0.75, h * 0.34, th * 1.15, 0, 0, Math.PI * 2);
  });
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(x - bw, y + 0.5);
  ctx.quadraticCurveTo(x - bw * 0.3, y - h * 0.3, x + lean - bw * 0.35, crownY);
  ctx.lineTo(x + lean + bw * 0.35, crownY);
  ctx.quadraticCurveTo(x + bw * 0.3, y - h * 0.3, x + bw, y + 0.5);
  ctx.closePath();
  blade(ctx, x + lean * 0.5, y - h * 0.36, h * 0.24, -0.75, bw * 0.8, 0);
  blade(ctx, x + lean * 0.6, y - h * 0.44, h * 0.2, 0.8, bw * 0.7, 0);
  ctx.fill();

  // Bark: a couple of paper grooves up the trunk's lit side.
  ctx.strokeStyle = paper;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.5, h * 0.01);
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  for (let i = 0; i < 2; i++) {
    const off = -bw * (0.15 + i * 0.3);
    ctx.moveTo(x + off * 1.6, y - 1);
    ctx.quadraticCurveTo(x + off, y - h * 0.3, x + lean + off * 0.4, crownY + h * 0.04);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // The crown: foliage masses with serrated, leafy edges, a few stray clumps
  // breaking the silhouette.
  const cx = x + lean;
  const cy = crownY - h * 0.1;
  const rx = h * 0.38;
  const ry = h * 0.27;
  const leafNoise = makeNoise1d(rng);
  const lumps = Array.from({ length: 11 + Math.floor(rng() * 5) }, () => {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * 0.72;
    return {
      x: cx + Math.cos(a) * rx * d,
      y: cy + Math.sin(a) * ry * d,
      r: ry * (0.36 + rng() * 0.24),
      seed: rng() * 100,
    };
  });
  const lumpPath = (l: (typeof lumps)[number], inset = 0) => {
    const n = 22;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const serrate = leafNoise(l.seed + i * 1.9) * 0.28 + (i % 2) * 0.06;
      const r = (l.r - inset) * (0.84 + serrate);
      const px = l.x + Math.cos(a) * r;
      const py = l.y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };
  ctx.fillStyle = ink;
  ctx.beginPath();
  for (const l of lumps) lumpPath(l);
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2;
    const r = 0.6 + rng() * h * 0.02;
    const px = cx + Math.cos(a) * rx * (0.98 + rng() * 0.12);
    const py = cy + Math.sin(a) * ry * (0.98 + rng() * 0.12);
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, Math.PI * 2);
  }
  ctx.fill();

  // Leaf texture cut in paper: each mass gets a thin rim of light along its
  // upper-left edge (so the masses separate), then flicks inside it,
  // crowded where the crown faces the light and sparse in its shade.
  ctx.strokeStyle = paper;
  ctx.lineWidth = Math.max(0.5, h * 0.01);
  for (const l of lumps) {
    const lit = clamp01(0.5 + ((cx - l.x) / rx + (cy - l.y) / ry) * 0.5);
    ctx.globalAlpha = 0.5 + lit * 0.45;
    ctx.beginPath();
    ctx.arc(l.x, l.y, l.r * 0.78, Math.PI * 1.05, Math.PI * 1.55);
    ctx.stroke();
    ctx.beginPath();
    const marks = Math.round(1 + lit * 10);
    for (let k = 0; k < marks; k++) {
      const a = Math.PI + rng() * (Math.PI / 2) + (rng() - 0.5) * 0.8;
      const d = (0.2 + rng() * 0.6) * l.r;
      const px = l.x + Math.cos(a) * d;
      const py = l.y + Math.sin(a) * d;
      const s2 = 0.6 + h * 0.012 + rng() * 0.5;
      ctx.moveTo(px - s2, py + s2 * 0.2);
      ctx.quadraticCurveTo(px, py - s2 * 0.9, px + s2, py - s2 * 0.1);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A gabled cabin, front wall lit, side wall hatched, smoke from the chimney. */
export function drawCabin(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  s: number,
  { ink, paper }: Inks,
) {
  const fw = s * 0.5;
  const wh = s * 0.36;
  const sw = s * 0.5;
  const skew = s * 0.1;
  const roofH = s * 0.3;
  const eaveY = y - wh;
  const ridgeX = x + fw / 2;
  const ridgeY = eaveY - roofH;
  const line = Math.max(0.6, s * 0.025);

  // The shadow of the house falls off its side wall onto the ground: the
  // wall's foot projected right, roof and all.
  const fall = wh * 2.6;
  const drop = wh * 0.45;
  groundShadow(ctx, rng, x + fw, y, sw + fall, fw * 0.8, ink, () => {
    ctx.moveTo(x + fw, y - 0.5);
    ctx.lineTo(x + fw + sw, y - skew - 0.5);
    ctx.lineTo(x + fw + sw + fall, y - skew + drop);
    ctx.lineTo(x + fw + sw * 0.5 + fall * 1.15, y - skew * 0.5 + drop * 1.3);
    ctx.lineTo(x + fw + fall * 0.8, y + drop);
    ctx.closePath();
  });

  const poly = (pts: [number, number][], fill: string, stroke = true) => {
    ctx.beginPath();
    for (const [i, [px, py]] of pts.entries()) {
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = line;
      ctx.stroke();
    }
  };

  // Side wall, in shadow: vertical hatching through a clip.
  const side: [number, number][] = [
    [x + fw, y],
    [x + fw + sw, y - skew],
    [x + fw + sw, y - skew - wh],
    [x + fw, eaveY],
  ];
  poly(side, paper);
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineWidth = line * 0.8;
  ctx.globalAlpha = 0.8;
  hatchClip(ctx, x + fw, eaveY - skew, sw, wh + skew, Math.max(1.2, s * 0.05), Math.PI / 2);
  ctx.restore();
  ctx.globalAlpha = 1;
  // Window on the side wall.
  const winX = x + fw + sw * 0.38;
  const winY = y - skew * 0.4 - wh * 0.75;
  const win = Math.max(1.6, s * 0.11);
  ctx.fillStyle = paper;
  ctx.fillRect(winX, winY, win, win);
  ctx.strokeStyle = ink;
  ctx.lineWidth = line;
  ctx.strokeRect(winX, winY, win, win);

  // Front wall and gable, lit.
  poly(
    [
      [x, y],
      [x + fw, y],
      [x + fw, eaveY],
      [ridgeX, ridgeY],
      [x, eaveY],
    ],
    paper,
  );
  ctx.fillStyle = ink;
  ctx.fillRect(x + fw * 0.38, y - wh * 0.62, fw * 0.24, wh * 0.62);

  // Roof plane receding to the right: solid ink with pale shingle rows.
  poly(
    [
      [ridgeX, ridgeY],
      [ridgeX + sw, ridgeY - skew],
      [x + fw + sw + s * 0.03, eaveY - skew + 0.5],
      [x + fw + s * 0.03, eaveY + 0.5],
    ],
    ink,
    false,
  );
  ctx.strokeStyle = paper;
  ctx.lineWidth = Math.max(0.5, s * 0.015);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let f = 0.25; f < 1; f += 0.25) {
    ctx.moveTo(ridgeX + (x + fw - ridgeX) * f, ridgeY + (eaveY - ridgeY) * f);
    ctx.lineTo(ridgeX + sw + (x + fw - ridgeX) * f, ridgeY - skew + (eaveY - ridgeY) * f);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Chimney, and smoke drifting off it as a few wavering lines that thin
  // and part as they rise.
  const chX = ridgeX + sw * 0.62;
  const chTop = ridgeY - skew * 0.62 - s * 0.12;
  ctx.fillStyle = ink;
  ctx.fillRect(chX, chTop, Math.max(1.5, s * 0.07), s * 0.2);
  const drift = 1 + rng() * 0.6;
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  for (let strand = 0; strand < 3; strand++) {
    ctx.lineWidth = Math.max(0.5, s * 0.03) * (1 - strand * 0.2);
    ctx.globalAlpha = 0.8 - strand * 0.18;
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const sx = chX + 1 + t * s * 1.4 * drift + Math.sin(t * 7 + strand * 1.3) * (0.6 + t * 2.2);
      const sy = chTop - 1 - t * s * 0.55 - strand * (0.8 + t * 1.6);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A boulder: a rounded dome lit on top, hatched low on the right, a shadow at its foot. */
export function drawRock(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  { ink, paper }: Inks,
  shadow = true,
) {
  const h = w * (0.34 + rng() * 0.22);
  if (shadow) {
    groundShadow(ctx, rng, x, y, w * 1.2, w * 0.7, ink, () => {
      ctx.moveTo(x + w * 1.25, y + w * 0.06);
      ctx.ellipse(x + w * 0.6, y + w * 0.08, w * 0.8, w * 0.2, 0, 0, Math.PI * 2);
    });
  }
  // Points round a low, uneven mound, then a smooth curve through their
  // midpoints; the summit sits off-centre so no two read as domes.
  const peak = (rng() - 0.5) * 0.6;
  const pts = Array.from({ length: 9 }, (_, i) => {
    const a = Math.PI - (i / 8) * Math.PI + peak * Math.sin((i / 8) * Math.PI);
    const r = 0.74 + rng() * 0.36;
    return [x + Math.cos(a) * (w / 2) * r, y - Math.sin(a) * h * r] as const;
  });
  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    for (let i = 0; i < pts.length - 1; i++) {
      const [px, py] = pts[i] as readonly [number, number];
      const [nx, ny] = pts[i + 1] as readonly [number, number];
      ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
    }
    ctx.lineTo(x + w / 2, y);
  };
  outline();
  ctx.closePath();
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(x + w * 0.32, y + h * 0.15, w * 0.62, h * 0.85, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(0.6, w * 0.03);
  ctx.globalAlpha = 0.85;
  hatchClip(ctx, x - w / 2, y - h * 1.2, w, h * 1.3, Math.max(1.2, w * 0.06), -0.55);
  ctx.restore();
  ctx.globalAlpha = 1;
  outline();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(0.8, w * 0.045);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - w / 2 - 1, y);
  ctx.lineTo(x + w / 2 + 1, y);
  ctx.lineWidth = Math.max(1, w * 0.06);
  ctx.stroke();
}

// ── On the water ─────────────────────────────────────────────────────────

/** A sloop under sail, with its hull's reflection broken in the swell. */
export function drawSailboat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  { ink, paper }: Inks,
) {
  const hw = h * 0.72;
  const mastX = x - hw * 0.05;
  const line = Math.max(0.6, h * 0.025);

  // Reflection first, so the hull sits on it: short vertical strokes hanging
  // under the hull and mast, broken by the swell.
  ctx.fillStyle = ink;
  ctx.beginPath();
  const streaks = Math.round(hw / 1.6);
  for (let i = 0; i < streaks; i++) {
    const sx = x - hw * 0.4 + (i / (streaks - 1)) * hw * 0.8;
    const len = h * (0.15 + Math.abs(Math.sin(i * 1.7)) * 0.3);
    blade(ctx, sx, y + 1.5, len, Math.PI, line * 1.6, 0);
  }
  blade(ctx, mastX, y + 2, h * 0.5, Math.PI, line * 1.2, 0);
  ctx.fill();

  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(x - hw / 2, y - h * 0.11);
  ctx.lineTo(x + hw / 2 + h * 0.07, y - h * 0.13);
  ctx.quadraticCurveTo(x + hw * 0.35, y + h * 0.04, x - hw * 0.35, y + h * 0.03);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = ink;
  ctx.lineWidth = line * 1.2;
  ctx.beginPath();
  ctx.moveTo(mastX, y - h * 0.1);
  ctx.lineTo(mastX, y - h);
  ctx.stroke();

  const sail = (pts: [number, number][], shaded: boolean) => {
    const [a, b, c] = pts as [[number, number], [number, number], [number, number]];
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.quadraticCurveTo((b[0] + c[0]) / 2, b[1] + h * 0.02, c[0], c[1]);
      ctx.quadraticCurveTo((a[0] + c[0]) / 2 + h * 0.06, (a[1] + c[1]) / 2, a[0], a[1]);
      ctx.closePath();
    };
    outline();
    ctx.fillStyle = paper;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = ink;
    ctx.lineWidth = line * 0.7;
    ctx.globalAlpha = shaded ? 0.75 : 0.35;
    hatchClip(ctx, x - hw, y - h, hw * 2, h, shaded ? 1.3 : 3, shaded ? 1.2 : 0.15);
    ctx.restore();
    ctx.globalAlpha = 1;
    // The path is the hatching now, not the sail: rebuild it to outline.
    outline();
    ctx.strokeStyle = ink;
    ctx.lineWidth = line;
    ctx.stroke();
  };
  sail(
    [
      [mastX + 0.8, y - h * 0.96],
      [mastX + 0.8, y - h * 0.17],
      [mastX + hw * 0.5, y - h * 0.17],
    ],
    false,
  );
  sail(
    [
      [mastX - 0.8, y - h * 0.86],
      [mastX - 0.8, y - h * 0.19],
      [x - hw * 0.48, y - h * 0.16],
    ],
    true,
  );
}

/** A far-off sail on the horizon: a sliver of ink. */
export function drawDistantSail(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  ink: string,
) {
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x + h * 0.5, y - h * 0.15);
  ctx.lineTo(x - h * 0.05, y - h * 0.15);
  ctx.closePath();
  ctx.rect(x - h * 0.35, y - h * 0.15, h * 0.85, Math.max(0.8, h * 0.12));
  ctx.fill();
}

/** Foam at a rock's waterline: short curls either side. */
function foam(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  ink: string,
) {
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const side = i % 2 ? 1 : -1;
    const fx = x + side * (w / 2 + 1 + rng() * w * 0.6);
    const fy = y + 1 + rng() * 2.5;
    const r = 1.2 + rng() * 2;
    ctx.moveTo(fx - r, fy);
    ctx.quadraticCurveTo(fx, fy - r * 0.9, fx + r, fy);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawSeaRock(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  inks: Inks,
) {
  drawRock(ctx, rng, x, y, w, inks, false);
  foam(ctx, rng, x, y, w, inks.ink);
}

/**
 * A rocky headland running in from one edge of the plate, a striped
 * lighthouse on its shoulder throwing beams into the sky. Returns the x range
 * it covers so other props keep off it.
 */
export function drawHeadland(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ground: Ground,
  { ink, paper }: Inks,
): [number, number] {
  const { width, height, horizon, depth } = ground;
  const fromLeft = rng() < 0.5;
  const reach = width * (0.16 + rng() * 0.08);
  const noise = makeNoise1d(rng);
  // u = 0 at the plate's edge, 1 at the headland's seaward tip.
  const X = (u: number) => (fromLeft ? u * reach : width - u * reach);
  const top = (u: number) => horizon - 10 + u ** 1.8 * depth * 0.5 + (noise(u * 9) - 0.5) * 4;
  const tipY = top(1);

  ctx.beginPath();
  ctx.moveTo(X(0), height);
  for (let u = 0; u <= 1.001; u += 0.02) ctx.lineTo(X(u), top(u));
  // The seaward face falls to the water as a rough scree slope, spreading
  // out toward the viewer rather than dropping in a straight seam.
  for (let v = 0; v <= 1.001; v += 0.05) {
    const spread = v ** 0.7 * reach * 0.35 + (noise(v * 9 + 3) - 0.4) * 7 * v;
    ctx.lineTo(X(1) + (fromLeft ? 1 : -1) * spread, tipY + (height - tipY) * v);
  }
  ctx.closePath();
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = 0.8;
  // Strata following the top, broken; denser toward the sea, where the face is in shadow.
  for (let r = 1; r < 26; r++) {
    ctx.beginPath();
    let drawing = false;
    for (let u = 0; u <= 1.45; u += 0.015) {
      const on = noise(u * 14 + r * 1.7) < 0.35 + u * 0.45;
      const px = X(u);
      const py = top(u) + r * 2.4;
      if (on && !drawing) ctx.moveTo(px, py);
      else if (on) ctx.lineTo(px, py);
      drawing = on;
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let u = 0; u <= 1.001; u += 0.02) {
    if (u === 0) ctx.moveTo(X(u), top(u));
    else ctx.lineTo(X(u), top(u));
  }
  ctx.stroke();
  foam(ctx, rng, X(1) + (fromLeft ? 1 : -1) * reach * 0.33, height - 4, 10, ink);
  foam(ctx, rng, X(0.95), tipY + (height - tipY) * 0.5, 8, ink);

  // The lighthouse on the headland's shoulder.
  const lu = 0.3 + rng() * 0.15;
  const lx = X(lu);
  const ly = top(lu) + 1;
  const lh = height * 0.2;
  const bw = lh * 0.2;
  const tw = lh * 0.13;
  const towerTop = ly - lh;
  const xAt = (f: number, side: -1 | 1) => lx + side * (bw / 2 + (tw / 2 - bw / 2) * f);

  // Beams first: fans of fine paper lines either side of the lantern,
  // fading as they spread, the way an engraver draws light.
  const lampY = towerTop - lh * 0.12;
  ctx.strokeStyle = paper;
  ctx.lineCap = "round";
  ctx.lineWidth = 0.7;
  for (const dir of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const spread = (i - 2.5) * 0.022;
      const len = width * (0.22 + (i % 2) * 0.06);
      ctx.globalAlpha = 0.5 - Math.abs(i - 2.5) * 0.08;
      ctx.beginPath();
      ctx.moveTo(lx + dir * (tw + 3), lampY + spread * (tw + 3));
      ctx.lineTo(lx + dir * len, lampY - lh * 0.08 + spread * len);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  groundShadow(ctx, rng, lx, ly, lh * 0.9, bw * 1.4, ink, () => {
    ctx.moveTo(lx - bw / 2, ly - 0.4);
    ctx.lineTo(lx + lh * 0.9, ly + 1.2);
    ctx.lineTo(lx + lh * 0.9, ly + 2.6);
    ctx.lineTo(lx + bw / 2, ly + 1.2);
    ctx.closePath();
  });

  const bands = 4;
  for (let b = 0; b < bands; b++) {
    const f0 = b / bands;
    const f1 = (b + 1) / bands;
    ctx.beginPath();
    ctx.moveTo(xAt(f0, -1), ly - lh * f0);
    ctx.lineTo(xAt(f1, -1), ly - lh * f1);
    ctx.lineTo(xAt(f1, 1), ly - lh * f1);
    ctx.lineTo(xAt(f0, 1), ly - lh * f0);
    ctx.closePath();
    ctx.fillStyle = b % 2 ? paper : ink;
    ctx.fill();
    if (b % 2) {
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.rect(lx, ly - lh, bw, lh);
      ctx.clip();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.6;
      ctx.globalAlpha = 0.8;
      hatchClip(ctx, lx - bw, ly - lh, bw * 2, lh, 1.2, Math.PI / 2);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(xAt(0, -1), ly);
  ctx.lineTo(xAt(1, -1), towerTop);
  ctx.moveTo(xAt(0, 1), ly);
  ctx.lineTo(xAt(1, 1), towerTop);
  ctx.stroke();

  // Gallery, lantern, cap.
  ctx.fillStyle = ink;
  ctx.fillRect(lx - tw / 2 - 2, towerTop - 1.6, tw + 4, 1.6);
  const lampH = lh * 0.16;
  ctx.fillStyle = paper;
  ctx.fillRect(lx - tw / 2 + 0.5, towerTop - 1.6 - lampH, tw - 1, lampH);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.7;
  ctx.strokeRect(lx - tw / 2 + 0.5, towerTop - 1.6 - lampH, tw - 1, lampH);
  ctx.beginPath();
  ctx.moveTo(lx, towerTop - 1.6 - lampH);
  ctx.lineTo(lx, towerTop - 1.6);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(lx, towerTop - 1.6 - lampH, tw / 2 + 0.6, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(lx - 0.4, towerTop - 1.6 - lampH - tw / 2 - 3, 0.8, 3);

  // Rays: short paper strokes around the lamp.
  ctx.strokeStyle = paper;
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  const lampMidY = towerTop - 1.6 - lampH / 2;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    if (Math.sin(a) > 0.5) continue;
    ctx.moveTo(lx + Math.cos(a) * (tw + 2), lampMidY + Math.sin(a) * (tw + 2));
    ctx.lineTo(lx + Math.cos(a) * (tw + 6), lampMidY + Math.sin(a) * (tw + 6));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // The keeper's cottage at the foot of the tower, toward the plate's edge.
  drawCabin(ctx, rng, lx + (fromLeft ? -lh * 0.55 : lh * 0.12), ly + 1, lh * 0.45, { ink, paper });

  const foot = reach * 1.35 + 12;
  return fromLeft ? [0, foot] : [width - foot, width];
}
