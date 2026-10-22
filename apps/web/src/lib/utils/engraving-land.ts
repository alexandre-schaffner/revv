import { blade, clamp01, hatchClip, makeNoise1d, type Rng } from "$lib/utils/engraving-marks";
import { type Ground, groundShadow, type Inks, type Prop } from "$lib/utils/engraving-props";

function curledBlade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  angle: number,
  baseWidth: number,
  curl: number,
) {
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
  const rootX = () => x + (rng() + rng() + rng() - 1.5) * spread * 0.32;
  const alpha = near < 0.25 ? 0.9 : 1;

  const inkBlades = (count: number, lenScale: number, widthScale: number, rise: number) => {
    for (let b = 0; b < count; b++) {
      const bx = rootX();
      const side = (bx - x) / spread;
      const angle = lean + side * 1.6 + (rng() - 0.5) * 0.45;
      const tall = 1 - Math.min(1, Math.abs(side) * 1.6);
      const len = size * lenScale * (0.5 + tall * 0.5) * (0.75 + rng() * 0.5);
      const curl =
        Math.sign(side || rng() - 0.5) * (0.6 + rng() * 1.6) * (0.4 + Math.abs(side) * 2);
      curledBlade(ctx, bx, y - rise, len, angle, weight * widthScale * (0.8 + rng() * 0.5), curl);
    }
  };

  ctx.globalAlpha = alpha;
  ctx.fillStyle = ink;
  ctx.beginPath();
  inkBlades(10 + Math.floor(near * 14), 1, 0.9, 0);
  inkBlades(12 + Math.floor(near * 18), 0.68, 1.35, -0.4);
  ctx.ellipse(x, y, spread * 0.36, Math.max(0.8, size * 0.09), 0, Math.PI, 0);
  ctx.fill();

  if (size > 5) {
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

    ctx.globalAlpha = alpha;
    ctx.fillStyle = ink;
    ctx.beginPath();
    inkBlades(1 + Math.floor(near * 3), 0.5, 0.8, -0.6);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

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

export interface Track {
  centre: (t: number) => number;
  half: (t: number) => number;
  covers: (x: number, y: number, margin?: number) => boolean;
}

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
      const t = ground.depthAtY(y);
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

  ctx.fillStyle = paper;
  ctx.beginPath();
  for (const [i, t] of ts.entries()) {
    if (i === 0) ctx.moveTo(edge(t, -1), ground.yAtDepth(t));
    else ctx.lineTo(edge(t, -1), ground.yAtDepth(t));
  }
  for (const t of [...ts].reverse()) ctx.lineTo(edge(t, 1), ground.yAtDepth(t));
  ctx.closePath();
  ctx.fill();

  const noise = makeNoise1d(rng);
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
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
      const y = ground.yAtDepth(t);
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
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 0; i < 40; i++) {
    const t = 0.15 + rng() * 0.9;
    const x = track.centre(t) + (rng() - 0.5) * track.half(t) * 1.4;
    const y = ground.yAtDepth(t);
    const len = 1 + t * 5 * rng();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

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
      y: ground.yAtDepth(t),
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
  const winX = x + fw + sw * 0.38;
  const winY = y - skew * 0.4 - wh * 0.75;
  const win = Math.max(1.6, s * 0.11);
  ctx.fillStyle = paper;
  ctx.fillRect(winX, winY, win, win);
  ctx.strokeStyle = ink;
  ctx.lineWidth = line;
  ctx.strokeRect(winX, winY, win, win);

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
