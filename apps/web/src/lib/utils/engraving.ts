// Engraved landscapes for the repo homepage hero.
//
// Each repo gets its own plate: a sky in solid ink, mountain ranges cut in
// contour hatching, snow on the tallest summits, and a foreground with a
// subject in it: a plain with a track, a fence, a lone tree, a cabin; or a
// moonlit sea with a sailboat and a lighthouse on its headland (the props
// live in `engraving-props.ts`). Two colours only, ink and paper, like a
// single-plate etching.
// Everything is drawn from a PRNG seeded on the repo's full name, so a repo's
// landscape is the same every time it is drawn, at any width.
//
// Marks are filled shapes wherever they are small. A hairline stroke under
// one device pixel antialiases into a grey smear, which is what made the
// first grass read as pixel noise; a tapered blade filled as a polygon keeps
// a clean edge at any scale and gets the engraver's swell for free.
//
// Pure canvas work: no DOM reads, no animation. `RepoEngraving.svelte` owns
// sizing and redraws.

import { hashString } from "$lib/utils/avatarPalette";
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
import {
  drawCabin,
  drawDistantSail,
  drawHeadland,
  drawRock,
  drawSailboat,
  drawSeaRock,
  drawSprig,
  drawTrack,
  drawTree,
  drawTuft,
  fenceProps,
  type Ground,
  makeGround,
  makeTrack,
  type Prop,
  paintProps,
} from "$lib/utils/engraving-props";

export interface EngravingInk {
  /** The plate's one ink: the sky, the hatching, the grass. */
  ink: string;
  /** The paper the ink is printed on: the ground and the mountain faces. */
  paper: string;
}

export interface EngravingOptions extends EngravingInk {
  seed: string;
  /** CSS pixels. */
  width: number;
  height: number;
  /**
   * How much of the width, from the left, the hero's text sits over. The
   * moon, stars, clouds and birds stay out of it.
   */
  textWidth: number;
  /**
   * `night`: a solid ink sky with a moon or sun, stars, paper clouds.
   * `day`: a paper sky in fine stipple, a sun, clouds left bare.
   * The land is the same plate either way.
   */
  time: "day" | "night";
}

// ── Ranges ────────────────────────────────────────────────────────────────

interface Ridge {
  /** Ridge height (canvas y) at x. */
  at: (x: number) => number;
  /** The lowest point the ridge reaches; hatching stops a little past it. */
  depth: number;
  /** 0 for the farthest range, rising toward the viewer. */
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
  // One or two summits per range, so the skyline has a subject rather than
  // being uniform noise. Kept to the right, clear of the hero's title.
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
    // Ease summits under the ceiling rather than shearing them flat.
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

/**
 * Engrave one mountain range the way a wood engraver cuts hillside: long
 * contour lines that wrap the range's form, their width carrying the tone —
 * hairlines that break up where the light falls, swelling into heavy
 * strokes in shade — so there's no outline; a range separates from the one
 * behind it by contrast.
 *
 * The light comes low from the left. What it lights is a terrain built from
 * the ridge profile plus ridged 2D noise, which breaks the face into
 * diagonal spurs, each with a lit side and a shaded side. Summits throw cast
 * shadows down the slope behind them. Near the summits the contour lines
 * wrinkle round the rock's relief, relaxing toward flat bands lower down.
 */
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

  // Cast shadow. The light is low (about 23° up) from the left, so a summit
  // throws its shadow down the slope behind it. Sweep left to right keeping
  // the lowest light line any ridge point to the left allows; where the
  // ridge sits below it, that stretch is in a summit's shadow, and the
  // shadow reaches further down the face the deeper the ridge sits.
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

  // Terrain. Spurs run down the face, fanning out from the summit: on its
  // left they fall away to the left, on its right to the right, so they read
  // as the mountain's structure rather than texture. Each is a ridged-noise
  // spine with a lit side and a shaded side. Far ranges get finer spurs.
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
  /** How much ink a point carries, 0 (bare paper) to 1 (solid). */
  const tone = (x: number, y: number) => {
    const d = y - ridge.at(x);
    // The main face: slopes falling away to the right face away from the light.
    const slope = (ridge.at(x + 3) - ridge.at(x - 3)) / 6;
    const face = Math.max(-0.3, Math.min(0.3, slope * 1.2)) * Math.exp(-d / 26);
    // The spurs: the side of each spine facing right is in shade, and the
    // shade is deepest in the fold between spines.
    const sd = spur(x - 2, y) - spur(x + 2, y);
    // Each spur's shadow is a wedge, starting and fading at its own height.
    const wedge = 0.35 + grainNoise(x / 45 + 50, d / 18) * 0.9;
    const spurShade = (sd > 0 ? Math.min(0.55, sd * 5) : Math.max(-0.2, sd * 2)) * wedge;
    const cast = d < shadowReach(x) ? 0.3 : 0;
    const grain = (grainNoise(x / 7, y / 3) - 0.5) * 0.2;
    // A thin lit strip along the crest separates a range from the one behind.
    const crest = Math.min(1, d / (3 + ridge.nearness * 3));
    const t = (0.32 + face + spurShade * Math.min(1, d / 10) + cast + grain) * crest;
    // Air between the viewer and the far ranges lightens them.
    return clamp01(t) * (0.75 + ridge.nearness * 0.25);
  };

  // The terrain's relief, which bends the contour lines near the summits.
  // Smooth in depth as well as across, so neighbouring lines bend together
  // into bulges and strata instead of crossing.
  const rock = (x: number, y: number) =>
    rockNoise(x / 18, y / 15) * 0.75 + rockNoise(x / 7, y / 8) * 0.25;

  ctx.save();
  silhouette();
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineCap = "butt";

  // Contour lines. Each one runs the width of the range, wrapping its form:
  // line k sits a fraction k/N of the way from the ridge down to the range's
  // foot, so lines follow the profile near the top and flatten toward the
  // base, and crowd together on the low flanks, where the slope is steep in
  // the picture. Where they'd crowd tighter than a line's width, lines taper
  // away by rank, the way engraved lines merge.
  //
  // Tone is the line's width, continuously: a ribbon that swells in shade
  // and thins toward the light until it breaks.
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
    // A line's rank: how many times 2 divides it. Higher ranks survive crowding.
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
      // Where lines crowd, they taper away in order of rank (odd lines
      // first, then every second, and so on), smoothly rather than at a
      // step, so there's no seam where the count changes.
      const spacing = span / lines;
      const fadeRank = clamp01((spacing * 2 ** (rank + 1) - gap) / gap);
      let w = 0;
      let y = 0;
      if (fadeRank > 0.05 && x <= width) {
        const d = span * f;
        // Relief: near the top of high ground the lines wrinkle round the
        // rock, and the wrinkling relaxes continuously with depth until the
        // lines lie almost flat at the range's foot. One set of lines all the
        // way down, so there's no seam between summit and slope.
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

/** A stand of pines along a ridge, each one a stack of tapered boughs. */
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
      // Trunk.
      ctx.rect(x - 0.45, y - h * 0.3, 0.9, h * 0.3 + 1);
      // Boughs: tiers that narrow toward the tip, each a pair of drooping blades.
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

// ── Foregrounds ──────────────────────────────────────────────────────────

/**
 * The plain in front of the ranges: perspective rows of dashes, then a
 * subject — a lone tree, a cabin, or both — with a track winding in from the
 * horizon, perhaps fenced, a few boulders, and grass, all painted far to near
 * so nearer things overlap farther ones.
 */
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

  // The ground: dotted rows in perspective, the way the plate stipples open
  // earth, with short dashes now and then and handwritten sprigs of grass
  // between them. Slow noise opens bare patches and darkens others, like
  // cloud shadow over the plain.
  ctx.fillStyle = ink;
  const rowCount = Math.round(depth / 2.6);
  for (let i = 0; i < rowCount; i++) {
    // Rows bunch up toward the horizon, open out toward the viewer.
    const t = (i + 0.5) / rowCount;
    const y = ground.y(t);
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
    drawSprig(ctx, rng, x, ground.y(0.05 + t * 0.95), 1.5 + t * 5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const track = rng() < 0.7 ? makeTrack(rng, ground) : null;
  if (track) drawTrack(ctx, rng, track, ground, inks);

  const props: Prop[] = [];
  // Subjects claim a stretch of x so two of them never stand in one spot.
  const taken: [number, number][] = [];
  const placeX = (t: number, w: number): number | null => {
    const y = ground.y(t);
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
    const y = ground.y(t);
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

  // Grass in depth bands: a jittered grid per band, so tufts spread evenly
  // instead of clumping, and grow (and thin out) toward the viewer. None on
  // the track itself; a fringe along its verges instead.
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
      // Grass grows in clumps: now and then a smaller neighbour alongside.
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
      const y = ground.y(t);
      const tuft = 2 + t * 12;
      props.push({ y, draw: () => drawTuft(ctx, rng, x, y, tuft, inks, t) });
    }
  }
  // A few big tufts cropped by the plate's edge put the viewer in the field.
  const near = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < near; i++) {
    const x = rng() * width;
    const y = height + 2 + rng() * 6;
    const tuft = 22 + rng() * 12;
    props.push({ y, draw: () => drawTuft(ctx, rng, x, y, tuft, inks, 1) });
  }
  paintProps(props);
}

/**
 * Open water as a woodcut sea: long swell lines that rise and dip across the
 * plate. Every line follows one swell field, so neighbouring lines move
 * together like the bands of a woodcut sea rather than wobbling apart.
 * Tone lives in the line's weight: a face turned from the light (falling to
 * the right) swells the line into a thick dark stroke, a lit face thins it
 * until it breaks. Lines tighten and flatten toward the horizon, run
 * heavier under the shore range where its reflection darkens the water, and
 * break in a column under the sun or moon.
 */
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
    const t = ground.t(y);
    return (7 + t * 70) * (0.6 + glintEdge(y * 0.9) * 0.8);
  };
  const inGlint = (x: number, y: number) => Math.abs(x - glintX) < glintHalf(y);

  ctx.fillStyle = ink;

  // The swell lines.
  const step = 1.5;
  ctx.beginPath();
  let t = 0.02;
  while (t < 1.06) {
    const base = ground.y(t);
    // Swells shrink with distance; each line samples its own slice of the
    // field so lines a little apart drift out of phase instead of lining up
    // into bands that fan from the vanishing point.
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
    // Walk the line, collecting ribbon pieces where it's in shade.
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
      // Falling to the right = facing away from the upper-left light.
      // The shore range's reflection: under high ground the water is dark,
      // so the lines there run heavier, fading with distance from the shore.
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

/**
 * What's on the water: sails on the horizon, perhaps a lighthouse on a
 * headland, a sloop (sometimes sailing right through the moon's glint), and
 * a few rocks in the surf.
 */
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
      ground.y(0.08 + rng() * 0.08),
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
    const y = ground.y(t);
    if (x !== null) props.push({ y, draw: () => drawSailboat(ctx, x, y, h, inks) });
  }
  const rocks = rng() < 0.5 ? 1 + Math.floor(rng() * 2) : 0;
  for (let i = 0; i < rocks; i++) {
    const t = 0.4 + rng() * 0.55;
    const w = 6 + t * 16;
    const x = freeX(w * 2);
    const y = ground.y(t);
    if (x !== null) props.push({ y, draw: () => drawSeaRock(ctx, rng, x, y, w, inks) });
  }
  paintProps(props);
}

// ── Sky ──────────────────────────────────────────────────────────────────

interface SkyBody {
  x: number;
  y: number;
}

/** The night sky: a crescent moon with a scatter of stars. The sun is the day sky's. */
function drawSky(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  skyline: number,
  farRidge: Ridge | undefined,
  opts: EngravingOptions,
): SkyBody {
  const { width, height, ink, paper, textWidth } = opts;
  // Between the text on the left and the hero's action button on the right.
  const left = Math.min(textWidth, width * 0.6);
  const right = width - Math.min(150, width * 0.2);
  const cx = left + (right - left) * (0.1 + rng() * 0.8);
  const cy = Math.max(height * 0.14, Math.min(skyline - 24, height * (0.16 + rng() * 0.16)));
  const clearOfText = (x: number, y: number) => x > textWidth + 56 || y > height * 0.45;

  // Horizon glow: paper stipple that thickens toward the ranges, the way an
  // aquatint sky lightens at the skyline.
  ctx.fillStyle = paper;
  const glow = Math.round(width * 1.1);
  for (let i = 0; i < glow; i++) {
    const d = rng() ** 2.2 * 40;
    const x = rng() * width;
    const ground = farRidge ? farRidge.at(x) : skyline;
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
    const fx = left + 56 + rng() * Math.max(0, right - left - 56);
    const fy = height * (0.2 + rng() * 0.18);
    const birds = 3 + Math.floor(rng() * 4);
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
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
function drawDaySky(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  skyline: number,
  opts: EngravingOptions,
): SkyBody {
  const { width, height, ink, textWidth } = opts;
  const left = Math.min(textWidth, width * 0.6);
  const right = width - Math.min(150, width * 0.2);
  const cx = left + (right - left) * (0.1 + rng() * 0.8);
  const cy = Math.max(height * 0.16, Math.min(skyline - 26, height * (0.18 + rng() * 0.14)));
  const sunR = 11 + rng() * 5;
  const clearOfText = (x: number, y: number) => x > textWidth + 56 || y > height * 0.45;
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
    const fx = left + 56 + rng() * Math.max(0, right - left - 56);
    const fy = height * (0.2 + rng() * 0.18);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    const birds = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < birds; i++) {
      const bx = fx + i * (9 + rng() * 6);
      const by = fy + (rng() - 0.3) * 10 + i * 1.5;
      if (!clearOfText(bx, by)) continue;
      const sz = 2.2 + rng() * 1.8;
      ctx.moveTo(bx - sz, by - sz * 0.3);
      ctx.quadraticCurveTo(bx - sz * 0.4, by - sz * 0.7, bx, by);
      ctx.quadraticCurveTo(bx + sz * 0.4, by - sz * 0.7, bx + sz, by - sz * 0.3);
    }
    ctx.stroke();
  }
  return { x: cx, y: cy };
}

/** Fine speckle in both colours over everything, so no area reads as flat fill. */
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

/**
 * Draw the plate into `ctx`, which must already be scaled so one unit is one
 * CSS pixel.
 */
export function drawEngraving(ctx: CanvasRenderingContext2D, opts: EngravingOptions): void {
  const { width, height, ink } = opts;
  const rng = makeRng(hashString(opts.seed) || 1);
  const foreground = pick<Foreground>(rng, ["plain", "plain", "sea"]);
  const pines = rng() < 0.45;

  const day = opts.time === "day";
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = day ? opts.paper : ink;
  ctx.fillRect(0, 0, width, height);

  // Over water the near range would sit in the sea; two ranges, set back.
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

  // The sky draws from its own stream, so day and night share one landscape.
  const skyRng = makeRng((hashString(opts.seed) ^ 0x5bd1e995) >>> 0 || 2);
  const body = day
    ? drawDaySky(ctx, skyRng, skyline, opts)
    : drawSky(ctx, skyRng, skyline, ranges[0], opts);
  for (const [i, range] of ranges.entries()) {
    engraveRange(ctx, rng, range, opts);
    // Paper against a paper sky needs its edge drawn; by night the sky does it.
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
