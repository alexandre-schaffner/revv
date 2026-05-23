/**
 * Motion tokens — typed mirror of the `@theme` block in app.css.
 *
 * GSAP needs durations in seconds and easings as either a built-in name or a
 * parsable string. CSS exposes the same values in ms and as `cubic-bezier(...)`.
 * This module is the single bridge.
 *
 * Reading strategy:
 * - Static fallbacks below match app.css verbatim and are used SSR and as the
 *   immediate value on first import.
 * - On first access in the browser we re-resolve from `getComputedStyle` so
 *   theme overrides or user CSS take effect.
 *
 * If you edit the values, edit app.css too — the comment there points here.
 */

type EaseString = string;

interface DurationTokens {
  instant: number;
  snap: number;
  quick: number;
  smooth: number;
  slow: number;
  page: number;
  ceremonialQuick: number;
  ceremonialMedium: number;
  ceremonialSlow: number;
  pulse: number;
}

interface EaseTokens {
  soft: EaseString;
  outExpo: EaseString;
  standard: EaseString;
  anticipate: EaseString;
}

interface StaggerTokens {
  tight: number;
  default: number;
  loose: number;
}

const FALLBACK_DURATIONS: DurationTokens = {
  instant: 0.08,
  snap: 0.12,
  quick: 0.16,
  smooth: 0.22,
  slow: 0.32,
  page: 0.48,
  ceremonialQuick: 0.28,
  ceremonialMedium: 0.48,
  ceremonialSlow: 0.72,
  pulse: 1.4,
};

// GSAP's CustomEase parses strings that start with a digit/dot/dash (regex
// `/^[\d.\-M][\d.\-,\s]/`) as cubic-bezier control points. The
// `cubic-bezier(...)` wrapper would fail that test, so the eases are stored
// as bare control-point lists — same numerics as the `--ease-*` CSS variables
// in app.css, just without the surrounding `cubic-bezier()`.
const FALLBACK_EASES: EaseTokens = {
  soft: "0.4, 0, 0.2, 1",
  outExpo: "0.16, 1, 0.3, 1",
  standard: "0.22, 0.61, 0.36, 1",
  anticipate: "0.68, -0.55, 0.27, 1.55",
};

function stripCubicBezier(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^cubic-bezier\((.+)\)$/);
  return match?.[1]?.trim() ?? trimmed;
}

const FALLBACK_STAGGER: StaggerTokens = {
  tight: 0.025,
  default: 0.04,
  loose: 0.08,
};

let resolved = false;
const durations: DurationTokens = { ...FALLBACK_DURATIONS };
const eases: EaseTokens = { ...FALLBACK_EASES };
const stagger: StaggerTokens = { ...FALLBACK_STAGGER };

function parseDurationMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith("ms")) {
    const n = parseFloat(trimmed.slice(0, -2));
    return Number.isFinite(n) ? n / 1000 : null;
  }
  if (trimmed.endsWith("s")) {
    const n = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n / 1000 : null;
}

function readVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

function resolveFromDom(): void {
  if (resolved) return;
  if (typeof document === "undefined") return;
  const styles = getComputedStyle(document.documentElement);

  const dMap: Record<keyof DurationTokens, string> = {
    instant: "--duration-instant",
    snap: "--duration-snap",
    quick: "--duration-quick",
    smooth: "--duration-smooth",
    slow: "--duration-slow",
    page: "--duration-page",
    ceremonialQuick: "--duration-ceremonial-quick",
    ceremonialMedium: "--duration-ceremonial-medium",
    ceremonialSlow: "--duration-ceremonial-slow",
    pulse: "--duration-pulse",
  };
  for (const [key, cssName] of Object.entries(dMap) as Array<
    [keyof DurationTokens, string]
  >) {
    const raw = readVar(styles, cssName);
    const parsed = parseDurationMs(raw);
    if (parsed !== null) durations[key] = parsed;
  }

  const eMap: Record<keyof EaseTokens, string> = {
    soft: "--ease-soft",
    outExpo: "--ease-out-expo",
    standard: "--ease-standard",
    anticipate: "--ease-anticipate",
  };
  for (const [key, cssName] of Object.entries(eMap) as Array<
    [keyof EaseTokens, string]
  >) {
    const raw = readVar(styles, cssName);
    if (raw) eases[key] = stripCubicBezier(raw);
  }

  const sMap: Record<keyof StaggerTokens, string> = {
    tight: "--stagger-tight",
    default: "--stagger-default",
    loose: "--stagger-loose",
  };
  for (const [key, cssName] of Object.entries(sMap) as Array<
    [keyof StaggerTokens, string]
  >) {
    const raw = readVar(styles, cssName);
    const parsed = parseDurationMs(raw);
    if (parsed !== null) stagger[key] = parsed;
  }

  resolved = true;
}

export const tokens = {
  get instant(): number {
    resolveFromDom();
    return durations.instant;
  },
  get snap(): number {
    resolveFromDom();
    return durations.snap;
  },
  get quick(): number {
    resolveFromDom();
    return durations.quick;
  },
  get smooth(): number {
    resolveFromDom();
    return durations.smooth;
  },
  get slow(): number {
    resolveFromDom();
    return durations.slow;
  },
  get page(): number {
    resolveFromDom();
    return durations.page;
  },
  get ceremonialQuick(): number {
    resolveFromDom();
    return durations.ceremonialQuick;
  },
  get ceremonialMedium(): number {
    resolveFromDom();
    return durations.ceremonialMedium;
  },
  get ceremonialSlow(): number {
    resolveFromDom();
    return durations.ceremonialSlow;
  },
  get pulse(): number {
    resolveFromDom();
    return durations.pulse;
  },
  get easeSoft(): EaseString {
    resolveFromDom();
    return eases.soft;
  },
  get easeOutExpo(): EaseString {
    resolveFromDom();
    return eases.outExpo;
  },
  get easeStandard(): EaseString {
    resolveFromDom();
    return eases.standard;
  },
  get easeAnticipate(): EaseString {
    resolveFromDom();
    return eases.anticipate;
  },
  stagger: {
    get tight(): number {
      resolveFromDom();
      return stagger.tight;
    },
    get default(): number {
      resolveFromDom();
      return stagger.default;
    },
    get loose(): number {
      resolveFromDom();
      return stagger.loose;
    },
  },
};

export type MotionTokens = typeof tokens;
