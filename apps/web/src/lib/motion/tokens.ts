// Generated from the `@theme` block in src/app.css by `bun run gen:motion-tokens`.
// Edit app.css and regenerate; `bun run lint` fails while the two disagree.

/**
 * Motion tokens for GSAP: durations and staggers in seconds, eases as bare
 * cubic-bezier control points (CustomEase parses any string starting with a
 * digit).
 */
export const tokens = {
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

  easeSoft: "0.4, 0, 0.2, 1",
  easeOutExpo: "0.16, 1, 0.3, 1",
  easeOutQuart: "0.25, 1, 0.5, 1",
  easeStandard: "0.22, 0.61, 0.36, 1",
  easeAnticipate: "0.68, -0.55, 0.27, 1.55",

  stagger: {
    tight: 0.025,
    default: 0.04,
    loose: 0.08,
    dealTotal: 0.09,
    gatherTotal: 0.04,
  },
} as const;
