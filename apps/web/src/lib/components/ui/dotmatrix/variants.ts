// ── Square dot-matrix variant registry ──────────────────────────────────────
// Faithful Svelte port of dotm-square-1..20 from the upstream dotmatrix
// library (https://dotmatrix.zzzzshawn.cloud, github.com/zzzzshawn/matrix).
//
// Each entry tells `Dotmatrix.svelte` how to animate the 5×5 grid:
//
//   kind: 'css'      — CSS keyframes own the animation. We supply a class
//                      name (and optionally per-dot CSS vars). The actual
//                      keyframes live in `dotmatrix-loader.css`.
//
//   kind: 'stepped'  — JS frame-stepping. We tick a discrete step counter
//                      and compute opacity per dot per step. Used for
//                      variants whose patterns can't be expressed as
//                      CSS keyframes (e.g. snake trails, Tetris fills).
//
//   kind: 'phase'    — JS continuous phase 0..1 via rAF. Used for variants
//                      driven by trigonometry (helix strands, sound bars).
//
// Reduced motion: `Dotmatrix.svelte` checks `prefers-reduced-motion: reduce`
// and renders `idleOpacity(...)` instead of running the JS loop. CSS variants
// are caught by the global motion reset in `app.css`.
//
// Geometry: cell index = row*5 + col, 0..24. Center is index 12 (row 2, col 2).

const N = 5;
const MAX_TRBL = (N - 1) * 2; // 8

function indexToCoord(idx: number): { row: number; col: number } {
	return { row: Math.floor(idx / N), col: idx % N };
}

function rowMajorIndex(row: number, col: number): number {
	return row * N + col;
}

// ── Precomputed path-order tables (each table[idx] = order along the path) ──

const TR_BL_PATH_NORM: number[] = Array.from({ length: N * N }, (_, idx) => {
	const { row, col } = indexToCoord(idx);
	return (row + (N - 1 - col)) / MAX_TRBL;
});

const SPIRAL_INWARD_ORDER: number[] = (() => {
	const order = new Array<number>(N * N);
	let top = 0,
		bottom = N - 1,
		left = 0,
		right = N - 1,
		t = 0;
	while (top <= bottom && left <= right) {
		for (let c = left; c <= right; c += 1) order[rowMajorIndex(top, c)] = t++;
		for (let r = top + 1; r <= bottom; r += 1) order[rowMajorIndex(r, right)] = t++;
		if (top < bottom)
			for (let c = right - 1; c >= left; c -= 1) order[rowMajorIndex(bottom, c)] = t++;
		if (left < right)
			for (let r = bottom - 1; r > top; r -= 1) order[rowMajorIndex(r, left)] = t++;
		top += 1;
		bottom -= 1;
		left += 1;
		right -= 1;
	}
	return order;
})();

const OUTER_RING_ORDER: number[] = (() => {
	const order = new Array<number>(N * N).fill(-1);
	const coords: Array<[number, number]> = [
		[0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
		[1, 4], [2, 4], [3, 4], [4, 4],
		[4, 3], [4, 2], [4, 1], [4, 0],
		[3, 0], [2, 0], [1, 0],
	];
	coords.forEach(([r, c], t) => {
		order[rowMajorIndex(r, c)] = t;
	});
	return order;
})();

const MIDDLE_RING_ORDER: number[] = (() => {
	const order = new Array<number>(N * N).fill(-1);
	const coords: Array<[number, number]> = [
		[1, 1], [2, 1], [3, 1],
		[3, 2], [3, 3],
		[2, 3], [1, 3], [1, 2],
	];
	coords.forEach(([r, c], t) => {
		order[rowMajorIndex(r, c)] = t;
	});
	return order;
})();

const DIAGONAL_SNAKE_ORDER: number[] = (() => {
	const order = new Array<number>(N * N);
	let t = 0;
	for (let d = 0; d <= (N - 1) * 2; d += 1) {
		const rs = Math.max(0, d - (N - 1));
		const re = Math.min(N - 1, d);
		if (d % 2 === 0) {
			for (let r = re; r >= rs; r -= 1) order[rowMajorIndex(r, d - r)] = t++;
		} else {
			for (let r = rs; r <= re; r += 1) order[rowMajorIndex(r, d - r)] = t++;
		}
	}
	return order;
})();

// ── square-2: snake path (16-segment cycle) ─────────────────────────────────
const SQUARE2_PATH: number[] = (() => {
	const path: number[] = [];
	const push = (r: number, c: number) => path.push(rowMajorIndex(r, c));
	for (let r = 4; r >= 0; r -= 1) push(r, 0);
	push(0, 1);
	push(0, 2);
	for (let r = 1; r <= 4; r += 1) push(r, 2);
	push(4, 1);
	for (let r = 3; r >= 0; r -= 1) push(r, 1);
	push(0, 2);
	push(0, 3);
	for (let r = 1; r <= 4; r += 1) push(r, 3);
	push(4, 2);
	for (let r = 3; r >= 0; r -= 1) push(r, 2);
	push(0, 3);
	push(0, 4);
	for (let r = 1; r <= 4; r += 1) push(r, 4);
	return path;
})();
const SQUARE2_VISITS: Map<number, number[]> = (() => {
	const m = new Map<number, number[]>();
	SQUARE2_PATH.forEach((idx, step) => {
		const list = m.get(idx) ?? [];
		list.push(step);
		m.set(idx, list);
	});
	return m;
})();
const SQUARE2_TAIL = [1, 0.82, 0.68, 0.54, 0.42, 0.31, 0.22, 0.14];

// ── square-7: tetromino fill / blink / drain ────────────────────────────────
const SQUARE7_MASKS = [
	'....................ooooo',
	'...............oooooooooo',
	'..........ooooooooooooooo',
	'.....oooooooooooooooooooo',
	'ooooooooooooooooooooooooo',
	'ccccccccccccccccccccccccc',
	'.........................',
	'ccccccccccccccccccccccccc',
	'.........................',
	'.........................',
];
const SQUARE7_SEQUENCE = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9];

// ── square-8: Tetris column stack ───────────────────────────────────────────
const SQUARE8_ROWS = N;
const SQUARE8_COLS = N;
const SQUARE8_FILL_LAST = SQUARE8_ROWS + SQUARE8_COLS - 1;
const SQUARE8_BLINK = [0.38, 1, 0.38, 1];
const SQUARE8_DRAIN_LAST = SQUARE8_FILL_LAST;
const SQUARE8_SEQ_LEN = SQUARE8_FILL_LAST + 1 + SQUARE8_BLINK.length + SQUARE8_DRAIN_LAST + 1;

function square8FillH(col: number, tick: number): number {
	return Math.max(0, Math.min(SQUARE8_ROWS, tick - col));
}

function square8DrainH(col: number, tick: number): number {
	return Math.max(0, Math.min(SQUARE8_ROWS, SQUARE8_ROWS - Math.max(0, tick - col)));
}

// ── square-13: 8-direction beacon ───────────────────────────────────────────
// 8 frames, each 25 chars (5 rows × 5 cols, row-major).
// `x` = peak, `o` = hub, `.` = base.
const SQUARE13_FRAMES: readonly string[] = [
	'..x..' + '..x..' + '..o..' + '.....' + '.....',
	'....x' + '...x.' + '..o..' + '.....' + '.....',
	'.....' + '.....' + '..oxx' + '.....' + '.....',
	'.....' + '.....' + '..o..' + '...x.' + '....x',
	'.....' + '.....' + '..o..' + '..x..' + '..x..',
	'.....' + '.....' + '..o..' + '.x...' + 'x....',
	'.....' + '.....' + 'xxo..' + '.....' + '.....',
	'x....' + '.x...' + '..o..' + '.....' + '.....',
];
const SQUARE13_SEQUENCE = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];

// ── square-19: figure-8 path (Lissajous-like) ───────────────────────────────
const SQUARE19_STEP_COUNT = 48;
const SQUARE19_CURVE_SAMPLES = Array.from({ length: 96 }, (_, idx) => {
	const t = (idx / 96) * Math.PI * 2;
	return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) };
});

function square19GridPoint(row: number, col: number) {
	return { x: (col - 2) / 2, y: (2 - row) / 2 };
}

function square19LoopPoint(step: number) {
	const t = ((step % SQUARE19_STEP_COUNT) / SQUARE19_STEP_COUNT) * Math.PI * 2;
	return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) };
}

function square19SqDist(a: { x: number; y: number }, b: { x: number; y: number }) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function square19MinCurveDistSq(p: { x: number; y: number }) {
	let m = Infinity;
	for (const s of SQUARE19_CURVE_SAMPLES) m = Math.min(m, square19SqDist(p, s));
	return m;
}

function square19HeadInfluence(dot: { x: number; y: number }, head: { x: number; y: number }) {
	return Math.exp(-square19SqDist(dot, head) / 0.19);
}

// ── square-20: perimeter loop with twist cues ───────────────────────────────
const SQUARE20_PATH: readonly number[] = [
	rowMajorIndex(0, 0), rowMajorIndex(0, 1), rowMajorIndex(0, 2),
	rowMajorIndex(0, 3), rowMajorIndex(0, 4),
	rowMajorIndex(1, 4), rowMajorIndex(2, 4), rowMajorIndex(3, 4),
	rowMajorIndex(4, 4), rowMajorIndex(4, 3), rowMajorIndex(4, 2),
	rowMajorIndex(4, 1), rowMajorIndex(4, 0),
	rowMajorIndex(3, 0), rowMajorIndex(2, 0), rowMajorIndex(1, 0),
];
const SQUARE20_LOOP_LEN = SQUARE20_PATH.length;
const SQUARE20_TAIL = [1, 0.82, 0.64, 0.46, 0.3, 0.18];
const SQUARE20_BACK_TAIL = [0.38, 0.3, 0.22, 0.14];
const SQUARE20_TWIST_INNER = new Map<number, number>([
	[0, rowMajorIndex(1, 1)],
	[4, rowMajorIndex(1, 3)],
	[8, rowMajorIndex(3, 3)],
	[12, rowMajorIndex(3, 1)],
]);

// ── square-9: braille bit layout ────────────────────────────────────────────
const SQ9_D1 = 0x01, SQ9_D2 = 0x02, SQ9_D3 = 0x04, SQ9_D4 = 0x08, SQ9_D5 = 0x10, SQ9_D6 = 0x20;

function square9BitForCell(row: number, col: number): number | null {
	if (row < 1 || row > 3) return null;
	const dr = row - 1;
	if (col === 0) return SQ9_D1 << dr;
	if (col === 1) return SQ9_D4 << dr;
	if (col === 3) return SQ9_D1 << dr;
	if (col === 4) return SQ9_D4 << dr;
	return null;
}

function square9BitClass(bit: number): string {
	if (bit === SQ9_D2) return 'dmx-square9-d2';
	if (bit === SQ9_D3) return 'dmx-square9-d3';
	if (bit === SQ9_D4) return 'dmx-square9-d4';
	if (bit === SQ9_D5) return 'dmx-square9-d5';
	if (bit === SQ9_D6) return 'dmx-square9-d6';
	return 'dmx-square9-d1';
}

// ── helpers ─────────────────────────────────────────────────────────────────

const manhattanDistance = (idx: number) => {
	const { row, col } = indexToCoord(idx);
	return Math.abs(row - 2) + Math.abs(col - 2);
};

const centerRippleRing = (idx: number) => {
	const { row, col } = indexToCoord(idx);
	return Math.abs(row - 1) + Math.abs(col - 1);
};

// ── types ───────────────────────────────────────────────────────────────────

/**
 * All 24 dot-matrix variants. The 20 `square-N` keys mirror upstream's
 * `dotm-square-1` … `dotm-square-20` naming. The four legacy names predate
 * the upstream port and are kept because `GuidedWalkthrough.svelte` and
 * its persisted state reference them by these strings.
 */
export type DotmatrixVariant =
	| 'ripple' | 'diagonal' | 'collapse' | 'prism-bloom'
	| 'square-1' | 'square-2' | 'square-3' | 'square-4' | 'square-5'
	| 'square-6' | 'square-7' | 'square-8' | 'square-9' | 'square-10'
	| 'square-11' | 'square-12' | 'square-13' | 'square-14' | 'square-15'
	| 'square-16' | 'square-17' | 'square-18' | 'square-19' | 'square-20';

/** Iterable list of all variant keys (handy for tests, random pickers, demos). */
export const DOTMATRIX_VARIANT_KEYS: readonly DotmatrixVariant[] = [
	'ripple', 'diagonal', 'collapse', 'prism-bloom',
	'square-1', 'square-2', 'square-3', 'square-4', 'square-5',
	'square-6', 'square-7', 'square-8', 'square-9', 'square-10',
	'square-11', 'square-12', 'square-13', 'square-14', 'square-15',
	'square-16', 'square-17', 'square-18', 'square-19', 'square-20',
] as const;

export interface PerDotInactive {
	inactive: true;
}

export interface PerDotCss {
	inactive?: false;
	/**
	 * Optional extra class on the dot. Variants where the keyframe is keyed
	 * purely by variant scope (`.dotmatrix.dotmatrix--ripple .dotmatrix-dot`)
	 * leave this off. Variants like `square-4` or `square-9` that fan out
	 * to multiple keyframes per variant supply the discriminating class.
	 */
	className?: string;
	vars?: Record<string, number | string>;
}

export type PerDotConfig = PerDotInactive | PerDotCss;

export type VariantConfig =
	| {
			kind: 'css';
			resolve: (idx: number, row: number, col: number) => PerDotConfig;
	  }
	| {
			kind: 'stepped';
			stepCount: number;
			cycleMs: number;
			opacity: (step: number, idx: number, row: number, col: number) => number;
			idleOpacity: (idx: number, row: number, col: number) => number;
	  }
	| {
			kind: 'phase';
			cycleMs: number;
			opacity: (phase: number, idx: number, row: number, col: number) => number;
			idleOpacity: (idx: number, row: number, col: number) => number;
	  };

// ── prism bloom (shared between legacy `prism-bloom` and `square-14`) ──────

const PRISM_BLOOM_FRAMES = [
	'x...x' + '.x.x.' + '..o..' + '.x.x.' + 'x...x',
	'..x..' + '.oxo.' + 'xooox' + '.oxo.' + '..x..',
	'.x.x.' + 'x.o.x' + '..o..' + 'x.o.x' + '.x.x.',
	'x.x.x' + '.o.o.' + 'x.o.x' + '.o.o.' + 'x.x.x',
] as const;
const PRISM_BLOOM_SEQUENCE = [0, 1, 2, 3, 2, 1] as const;

function prismBloomConfig(): VariantConfig {
	return {
		kind: 'stepped',
		stepCount: PRISM_BLOOM_SEQUENCE.length,
		cycleMs: PRISM_BLOOM_SEQUENCE.length * 354,
		opacity: (step, _idx, row, col) => {
			const frame = PRISM_BLOOM_FRAMES[PRISM_BLOOM_SEQUENCE[step]!]!;
			const ch = frame[rowMajorIndex(row, col)] ?? '.';
			if (ch === 'x') return 1;
			if (ch === 'o') return 0.52;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	};
}

// ── registry ────────────────────────────────────────────────────────────────

export const DOTMATRIX_VARIANTS: Record<DotmatrixVariant, VariantConfig> = {
	// Legacy: ripple — center-out radial pulse via manhattan distance.
	// CSS rule lives in `dotmatrix-loader.css` keyed on `.dotmatrix--ripple`.
	ripple: {
		kind: 'css',
		resolve: (_idx, row, col) => ({
			vars: { '--dmx-manhattan': Math.abs(row - 2) + Math.abs(col - 2) },
		}),
	},

	// Legacy: diagonal — top-left → bottom-right pulse sweep.
	diagonal: {
		kind: 'css',
		resolve: (_idx, row, col) => ({
			vars: { '--dmx-path-order': row + col },
		}),
	},

	// Legacy: collapse — outside-in ring collapse.
	collapse: {
		kind: 'css',
		resolve: (_idx, row, col) => ({
			vars: { '--dmx-collapse-order': 4 - (Math.abs(row - 2) + Math.abs(col - 2)) },
		}),
	},

	// Legacy: prism-bloom — palindrome kaleidoscope. Same frame data and
	// timing as `square-14` (upstream's "Prism Bloom"); shared with that
	// variant since the dotm-square-14 walkthrough-chapter implementation
	// is historically how this variant was authored.
	'prism-bloom': prismBloomConfig(),

	// Neon Drift — diagonal alternating sweep, top-right → bottom-left.
	'square-1': {
		kind: 'css',
		resolve: (idx, row, col) => {
			const slice = row + (4 - col);
			const parity = slice % 2;
			return {
				vars: {
					'--dmx-path': TR_BL_PATH_NORM[idx]!,
					'--dmx-diagonal-parity': parity,
				},
			};
		},
	},

	// Pulse Ladder — clockwise snake route with 8-step trailing tail.
	'square-2': {
		kind: 'stepped',
		stepCount: SQUARE2_PATH.length,
		cycleMs: 1500,
		opacity: (step, idx) => {
			const visits = SQUARE2_VISITS.get(idx) ?? [];
			let op = 0.08;
			for (const s of visits) {
				const d = (step - s + SQUARE2_PATH.length) % SQUARE2_PATH.length;
				if (d >= 0 && d < SQUARE2_TAIL.length) op = Math.max(op, SQUARE2_TAIL[d]!);
			}
			return op;
		},
		idleOpacity: () => 0.08,
	},

	// Core Spiral — 4-dot snake spirals inward from the outer border.
	'square-3': {
		kind: 'css',
		resolve: (idx) => ({
			vars: { '--dmx-spiral-order': SPIRAL_INWARD_ORDER[idx]! },
		}),
	},

	// Twin Orbit — outer ring CW + middle ring CCW; center dot inactive.
	// Outer/middle classes ARE meaningful: they pick different keyframes.
	'square-4': {
		kind: 'css',
		resolve: (idx, row, col) => {
			if (row === 2 && col === 2) return { inactive: true };
			const outer = OUTER_RING_ORDER[idx]!;
			if (outer >= 0) {
				return {
					className: 'dmx-outer-snake',
					vars: { '--dmx-outer-order': outer },
				};
			}
			const middle = MIDDLE_RING_ORDER[idx]!;
			return {
				className: 'dmx-middle-snake',
				vars: { '--dmx-middle-order': middle },
			};
		},
	},

	// Prism Sweep — snake along alternating diagonals.
	'square-5': {
		kind: 'css',
		resolve: (idx) => ({
			vars: { '--dmx-diagonal-snake-order': DIAGONAL_SNAKE_ORDER[idx]! },
		}),
	},

	// Flux Columns — five simultaneous column snakes, alternating direction.
	'square-6': {
		kind: 'css',
		resolve: (_idx, row, col) => {
			const goesUp = col % 2 === 0;
			const pos = goesUp ? 4 - row : row;
			return { vars: { '--dmx-col-pos': pos } };
		},
	},

	// Block Drop — tetromino fill→blink→drain.
	'square-7': {
		kind: 'stepped',
		stepCount: SQUARE7_SEQUENCE.length,
		cycleMs: 1900,
		opacity: (step, _idx, row, col) => {
			const frame = SQUARE7_SEQUENCE[step] ?? 0;
			const mask = SQUARE7_MASKS[frame] ?? SQUARE7_MASKS[0]!;
			const ch = mask[rowMajorIndex(row, col)] ?? '.';
			if (ch === 'x') return 1;
			if (ch === 'o') return 0.42;
			if (ch === 'c') return 0.88;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	},

	// Strobe Stack — column stack rises, blinks, drains.
	'square-8': {
		kind: 'stepped',
		stepCount: SQUARE8_SEQ_LEN,
		cycleMs: 2000,
		opacity: (step, _idx, row, col) => {
			let height = 0;
			let blink: number | null = null;
			if (step <= SQUARE8_FILL_LAST) {
				height = square8FillH(col, step);
			} else if (step < SQUARE8_FILL_LAST + 1 + SQUARE8_BLINK.length) {
				height = SQUARE8_ROWS;
				blink = SQUARE8_BLINK[step - (SQUARE8_FILL_LAST + 1)] ?? 1;
			} else {
				const dt = step - (SQUARE8_FILL_LAST + 1 + SQUARE8_BLINK.length);
				height = square8DrainH(col, dt);
			}
			const topLit = SQUARE8_ROWS - height;
			const isLit = height > 0 && row >= topLit && row <= SQUARE8_ROWS - 1;
			if (!isLit) return 0.08;
			if (blink !== null) return blink;
			const isCap = row === topLit && height > 0 && height < SQUARE8_ROWS;
			return isCap ? 1 : 0.52;
		},
		idleOpacity: () => 0.08,
	},

	// Glyph Pulse — 2×3 braille cells with per-bit keyframes.
	'square-9': {
		kind: 'css',
		resolve: (_idx, row, col) => {
			// Middle "gap" column (col 2) inside the 3-row braille band
			if (row >= 1 && row <= 3 && col === 2) {
				return { inactive: true }; // GAP cells render as inactive
			}
			const bit = square9BitForCell(row, col);
			if (bit === null) return { inactive: true };
			return {
				className: `dmx-square9-bit ${square9BitClass(bit)}`,
			};
		},
	},

	// CRT Glide — horizontal scanline with exponential persistence.
	'square-10': {
		kind: 'stepped',
		stepCount: N,
		cycleMs: 1500,
		opacity: (step, _idx, row, col) => {
			const colGain = 1 + 0.07 * Math.sin(col * 1.72 + step * 0.61);
			if (row > step) return 0.08;
			const age = step - row;
			const trail = Math.exp(-age * 0.72);
			return Math.min(1, 0.08 + (1 - 0.08) * trail * colGain);
		},
		idleOpacity: (_idx, row) => 0.08 + ((N - 1 - row) / Math.max(1, N - 1)) * 0.38,
	},

	// Echo Ring — concentric diamond ripple keyed on manhattan distance.
	'square-11': {
		kind: 'css',
		resolve: (idx) => {
			const ring = Math.max(0, Math.min(4, manhattanDistance(idx)));
			return { vars: { '--dmx-ripple-ring': ring, '--dmx-ripple-parity': ring % 2 } };
		},
	},

	// Origin Wave — ripple from cell (1,1) outward.
	'square-12': {
		kind: 'css',
		resolve: (idx) => {
			const ring = Math.max(0, Math.min(6, centerRippleRing(idx)));
			return { vars: { '--dmx-center-ripple-ring': ring } };
		},
	},

	// Core Rotor — 8-direction beacon, single fan blade.
	'square-13': {
		kind: 'stepped',
		stepCount: SQUARE13_SEQUENCE.length,
		cycleMs: 1550,
		opacity: (step, _idx, row, col) => {
			const frameIdx = SQUARE13_SEQUENCE[step] ?? 0;
			const mask = SQUARE13_FRAMES[frameIdx] ?? SQUARE13_FRAMES[0]!;
			const ch = mask[rowMajorIndex(row, col)] ?? '.';
			if (ch === 'x') return 1;
			if (ch === 'o') return 0.56;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	},

	// Prism Bloom — kaleidoscope palindrome (4 frames, 6-step palindrome).
	// Same as the legacy `prism-bloom` variant but exposed under the
	// canonical square-N name. Walkthrough still uses `prism-bloom`.
	'square-14': prismBloomConfig(),

	// Helix Glow — DNA-style helix sweeping rows.
	'square-15': {
		kind: 'phase',
		cycleMs: 1600,
		opacity: (phase, _idx, row, col) => {
			const rowPhase = phase * 2 * 2 * Math.PI + row * 1.24;
			const left = Math.round(1 + Math.sin(rowPhase));
			const right = 4 - left;
			const bridge = Math.cos(rowPhase * 2) > 0.82;
			if (col === left || col === right) return 1;
			if (bridge && col > left && col < right) return 0.58;
			if (Math.abs(col - left) === 1 || Math.abs(col - right) === 1) return 0.24;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	},

	// Helix Core — tight center-band helix variant of square-15.
	'square-16': {
		kind: 'phase',
		cycleMs: 1400,
		opacity: (phase, _idx, row, col) => {
			const stepCount = 20;
			const radians = (Math.PI * 2) / (stepCount - 1);
			const t = phase * stepCount;
			const rowPhase = t * radians + row * 1.24;
			const left = Math.round(1.5 + 0.5 * Math.sin(rowPhase));
			const right = 4 - left;
			const bridge = Math.cos(rowPhase * 2) > 0.82;
			if (col === left || col === right) return 1;
			if (bridge && col > left && col < right) return 0.58;
			if (Math.abs(col - left) === 1 || Math.abs(col - right) === 1) return 0.24;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	},

	// Half Helix — one strand sweeping across.
	'square-17': {
		kind: 'phase',
		cycleMs: 1600,
		opacity: (phase, _idx, row, col) => {
			const stepCount = 20;
			const radians = (Math.PI * 2) / (stepCount - 1);
			const t = phase * stepCount;
			const rowPhase = t * radians + row * 1.24;
			const strand = Math.round(2 + 2 * Math.sin(rowPhase));
			if (col === strand) return 1;
			if (Math.abs(col - strand) === 1) return 0.24;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	},

	// Sound Bars — equalizer columns.
	'square-18': {
		kind: 'phase',
		cycleMs: 1750,
		opacity: (phase, _idx, row, col) => {
			const stepCount = 24;
			const t = phase * stepCount;
			const colPhase = t * 0.52 + col * 1.15;
			const level = Math.max(1, Math.min(5, Math.round(1 + ((Math.sin(colPhase) + 1) / 2) * 4)));
			const topLit = 5 - level;
			if (row > topLit) return 0.94;
			if (row === topLit) return 1;
			return 0.08;
		},
		idleOpacity: () => 0.08,
	},

	// Infinity Run — figure-eight Lissajous with two heads + trails.
	'square-19': {
		kind: 'stepped',
		stepCount: SQUARE19_STEP_COUNT,
		cycleMs: 1700,
		opacity: (step, _idx, row, col) => {
			const dot = square19GridPoint(row, col);
			const headA = square19LoopPoint(step);
			const headB = square19LoopPoint(step + SQUARE19_STEP_COUNT / 2);
			const trailA = square19LoopPoint(step - 4);
			const trailB = square19LoopPoint(step + SQUARE19_STEP_COUNT / 2 - 4);
			const lead = Math.max(
				square19HeadInfluence(dot, headA),
				square19HeadInfluence(dot, headB),
			);
			const trail = Math.max(
				square19HeadInfluence(dot, trailA),
				square19HeadInfluence(dot, trailB),
			);
			const centerPulse = Math.exp(-(dot.x * dot.x + dot.y * dot.y) / 0.05) * (0.45 + 0.55 * lead);
			return Math.min(1, 0.08 + 0.32 * trail + 0.62 * lead + 0.16 * centerPulse);
		},
		idleOpacity: (_idx, row, col) => {
			const dot = square19GridPoint(row, col);
			const curveGlow = Math.exp(-square19MinCurveDistSq(dot) / 0.2);
			const centerBoost = Math.exp(-(dot.x * dot.x + dot.y * dot.y) / 0.06);
			return Math.min(1, 0.08 + curveGlow * 0.2 + centerBoost * 0.18);
		},
	},

	// Mobius Run — perimeter loop with twist-inner cues + seam pulse.
	'square-20': {
		kind: 'stepped',
		stepCount: SQUARE20_LOOP_LEN,
		cycleMs: 1600,
		opacity: (step, idx) => {
			const onLoop = SQUARE20_PATH.indexOf(idx);
			const backHead = (step + Math.floor(SQUARE20_LOOP_LEN / 2)) % SQUARE20_LOOP_LEN;
			let op = 0.08;
			if (onLoop >= 0) {
				const forward = (step - onLoop + SQUARE20_LOOP_LEN) % SQUARE20_LOOP_LEN;
				const along = (backHead - onLoop + SQUARE20_LOOP_LEN) % SQUARE20_LOOP_LEN;
				if (forward < SQUARE20_TAIL.length) op = Math.max(op, SQUARE20_TAIL[forward]!);
				if (along < SQUARE20_BACK_TAIL.length) op = Math.max(op, SQUARE20_BACK_TAIL[along]!);
			}
			const twistInner = SQUARE20_TWIST_INNER.get(step);
			if (twistInner === idx) op = Math.max(op, 0.52);
			if (idx === rowMajorIndex(2, 2) && step % 4 === 0) op = Math.max(op, 0.55);
			return Math.min(1, op);
		},
		idleOpacity: (idx) => {
			const onLoop = SQUARE20_PATH.indexOf(idx);
			if (onLoop >= 0) return 0.48;
			if (idx === rowMajorIndex(2, 2)) return 0.22;
			return 0.08;
		},
	},
};
