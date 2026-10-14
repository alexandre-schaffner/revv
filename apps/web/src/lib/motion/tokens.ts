/**
 * Motion tokens — typed mirror of the `@theme` block in `app.css`.
 *
 * GSAP wants durations in seconds and eases as bare cubic-bezier control
 * points (CustomEase parses any string starting with a digit). CSS uses ms
 * and `cubic-bezier(...)`. The values below match `app.css` — keep them in
 * sync by hand if you edit either side.
 */
export const tokens = {
  // Durations (seconds)
  instant: 0.08,
  snap: 0.12,
  quick: 0.16,
  smooth: 0.22,
  slow: 0.32,
  pulse: 1.4,

  // Easings (bare cubic-bezier control points; CustomEase consumes these)
  easeOutExpo: "0.16, 1, 0.3, 1",
  // Gentler than expo: most of the travel early, but no snap. For motion
  // the eye follows the whole way (a hover lift, cards being dealt).
  easeOutQuart: "0.25, 1, 0.5, 1",
  easeSoft: "0.4, 0, 0.2, 1",

  stagger: {
    tight: 0.025,
    // Total budgets, not per item: spread across however many cards a stack
    // has, so a tall one deals as quickly as a short one. Gathering is the
    // exit, so it's quicker.
    deal: 0.09,
    gather: 0.04,
  },
} as const;
