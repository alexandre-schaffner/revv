import { drawCabin, drawRock } from "$lib/utils/engraving-land";
import { blade, hatchClip, makeNoise1d, type Rng } from "$lib/utils/engraving-marks";
import { type Ground, groundShadow, type Inks } from "$lib/utils/engraving-props";

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
  const xFromEdge = (towardTip: number) =>
    fromLeft ? towardTip * reach : width - towardTip * reach;
  const top = (u: number) => horizon - 10 + u ** 1.8 * depth * 0.5 + (noise(u * 9) - 0.5) * 4;
  const tipY = top(1);

  ctx.beginPath();
  ctx.moveTo(xFromEdge(0), height);
  for (let u = 0; u <= 1.001; u += 0.02) ctx.lineTo(xFromEdge(u), top(u));
  for (let v = 0; v <= 1.001; v += 0.05) {
    const spread = v ** 0.7 * reach * 0.35 + (noise(v * 9 + 3) - 0.4) * 7 * v;
    ctx.lineTo(xFromEdge(1) + (fromLeft ? 1 : -1) * spread, tipY + (height - tipY) * v);
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
  for (let r = 1; r < 26; r++) {
    ctx.beginPath();
    let drawing = false;
    for (let u = 0; u <= 1.45; u += 0.015) {
      const on = noise(u * 14 + r * 1.7) < 0.35 + u * 0.45;
      const px = xFromEdge(u);
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
    if (u === 0) ctx.moveTo(xFromEdge(u), top(u));
    else ctx.lineTo(xFromEdge(u), top(u));
  }
  ctx.stroke();
  foam(ctx, rng, xFromEdge(1) + (fromLeft ? 1 : -1) * reach * 0.33, height - 4, 10, ink);
  foam(ctx, rng, xFromEdge(0.95), tipY + (height - tipY) * 0.5, 8, ink);

  const lu = 0.3 + rng() * 0.15;
  const lx = xFromEdge(lu);
  const ly = top(lu) + 1;
  const lh = height * 0.2;
  const bw = lh * 0.2;
  const tw = lh * 0.13;
  const towerTop = ly - lh;
  const xAt = (f: number, side: -1 | 1) => lx + side * (bw / 2 + (tw / 2 - bw / 2) * f);

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

  drawCabin(ctx, rng, lx + (fromLeft ? -lh * 0.55 : lh * 0.12), ly + 1, lh * 0.45, { ink, paper });

  const foot = reach * 1.35 + 12;
  return fromLeft ? [0, foot] : [width - foot, width];
}
