import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

interface StackSnapshot {
  readonly height: number;
  readonly rects: readonly DOMRect[];
}

export function snapshotStack(
  container: HTMLElement,
  pieces: readonly HTMLElement[],
): StackSnapshot {
  return {
    height: container.getBoundingClientRect().height,
    rects: pieces.map((piece) => piece.getBoundingClientRect()),
  };
}

const running = new WeakMap<HTMLElement, gsap.core.Timeline>();

const CLEARED = "transform,transformOrigin,opacity,height,clipPath,willChange,--elev";

const CLIP_BOTTOM_EDGE_ONLY = "inset(-1rem -1rem 0 -1rem)";

const CARDS_VISIBLE_WHILE_FOLDED = 3;

const SHORT_STACK_CARDS = 2;
const TALL_STACK_CARDS = 11;
const TALL_STACK_EXTRA_TIME = { deal: 0.5, gather: 0.4 } as const;

function tallness(cardCount: number): number {
  return Math.min(1, (cardCount - SHORT_STACK_CARDS) / (TALL_STACK_CARDS - SHORT_STACK_CARDS));
}

export function flipStack(
  container: HTMLElement,
  cards: readonly HTMLElement[],
  faces: readonly HTMLElement[],
  foot: HTMLElement | null,
  from: StackSnapshot,
  opening: boolean,
): void {
  const everything = [container, ...cards, ...faces, ...(foot ? [foot] : [])];
  running.get(container)?.kill();
  gsap.set(everything, { clearProps: CLEARED });
  if (prefersReducedMotion()) return;

  const to = snapshotStack(container, foot ? [...cards, foot] : cards);
  const tall = tallness(cards.length);
  const duration = opening
    ? tokens.slow * (1 + TALL_STACK_EXTRA_TIME.deal * tall)
    : tokens.smooth * (1 + TALL_STACK_EXTRA_TIME.gather * tall);
  const ease = opening ? tokens.easeOutQuart : tokens.easeSoft;
  const spread = opening ? tokens.stagger.dealTotal : tokens.stagger.gatherTotal;

  const tl = gsap.timeline({
    onUpdate: () => hangFoot(container, cards, foot, to),
    onComplete: () => {
      gsap.set(everything, { clearProps: CLEARED });
      running.delete(container);
    },
  });
  running.set(container, tl);

  gsap.set(container, { height: from.height, clipPath: CLIP_BOTTOM_EDGE_ONLY });
  gsap.set(cards.slice(1), { willChange: "transform" });

  tl.fromTo(
    cards.slice(1),
    {
      x: (i) => offset(from, to, i + 1).x,
      y: (i) => offset(from, to, i + 1).y,
      scaleX: (i) => offset(from, to, i + 1).scaleX,
      transformOrigin: "top left",
    },
    {
      x: 0,
      y: 0,
      scaleX: 1,
      duration,
      ease,
      stagger: { amount: spread, from: opening ? "start" : "end" },
    },
    0,
  );

  tl.fromTo(
    container,
    { "--elev": opening ? 1 : 0 },
    {
      "--elev": opening ? 0 : 1,
      duration: opening ? duration : duration * 0.5,
      ease: tokens.easeSoft,
    },
    0,
  );

  const hiddenWhileFolded = cards.slice(CARDS_VISIBLE_WHILE_FOLDED);
  if (hiddenWhileFolded.length > 0) {
    tl.fromTo(
      hiddenWhileFolded,
      { opacity: opening ? 0 : 1 },
      { opacity: opening ? 1 : 0, duration: duration * 0.6, ease: tokens.easeSoft },
      opening ? 0 : duration * 0.4,
    );
  }

  tl.fromTo(
    faces.slice(1),
    { opacity: opening ? 0 : 1 },
    {
      opacity: opening ? 1 : 0,
      duration: duration * (opening ? 0.7 : 0.5),
      ease: tokens.easeSoft,
      stagger: opening ? { amount: spread } : 0,
    },
    opening ? duration * 0.3 : 0,
  );
}

function offset(
  from: StackSnapshot,
  to: StackSnapshot,
  i: number,
): { x: number; y: number; scaleX: number } {
  const a = from.rects[i];
  const b = to.rects[i];
  if (!a || !b || b.width === 0) return { x: 0, y: 0, scaleX: 1 };
  return { x: a.left - b.left, y: a.top - b.top, scaleX: a.width / b.width };
}

function hangFoot(
  container: HTMLElement,
  cards: readonly HTMLElement[],
  foot: HTMLElement | null,
  to: StackSnapshot,
): void {
  let lowestRest = Number.NEGATIVE_INFINITY;
  let lowestNow = Number.NEGATIVE_INFINITY;
  cards.forEach((card, i) => {
    const rest = to.rects[i];
    if (!rest) return;
    lowestRest = Math.max(lowestRest, rest.bottom);
    lowestNow = Math.max(lowestNow, rest.bottom + Number(gsap.getProperty(card, "y")));
  });
  const shift = lowestNow - lowestRest;
  if (foot) gsap.set(foot, { y: shift });
  gsap.set(container, { height: to.height + shift });
}
