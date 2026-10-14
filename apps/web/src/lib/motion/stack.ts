/**
 * Fold and unfold a stack of cards (the homepage's PR stacks).
 *
 * FLIP: the caller snapshots the stack, flips its state so the DOM lands in
 * the new layout, then hands both to `flipStack`, which plays each card from
 * where it was to where it now is. The layout itself stays pure CSS, so a
 * reduced-motion reader, an SSE re-render or an interrupted fold all settle
 * on exactly what the stylesheet says.
 *
 * Unfolding deals the cards out from under the top one: each slides down
 * from its sheet, widening to full size, and its face fades in once it has
 * cleared the card above, while the whole pile flattens into rows. Folding
 * gathers them back, faster, the way an exit should be: the rows turn back
 * into sheets and their faces go first, then the cards tuck under.
 */
import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

interface StackSnapshot {
  readonly height: number;
  readonly rects: readonly DOMRect[];
  /**
   * Each piece's `--shade`: how far its paper is mixed toward ink. Folded
   * sheets are shaded by depth. A number, not the computed colour, because
   * the colour is a `color-mix()` GSAP can't parse.
   */
  readonly shades: readonly number[];
}

/** Every moving part, in DOM order: the cards, then whatever follows them (the foot). */
export function snapshotStack(
  container: HTMLElement,
  pieces: readonly HTMLElement[],
): StackSnapshot {
  return {
    height: container.getBoundingClientRect().height,
    rects: pieces.map((piece) => piece.getBoundingClientRect()),
    shades: pieces.map(
      (piece) => Number.parseFloat(getComputedStyle(piece).getPropertyValue("--shade")) || 0,
    ),
  };
}

const running = new WeakMap<HTMLElement, gsap.core.Timeline>();

const CLEARED = "transform,transformOrigin,opacity,height,clipPath,willChange,--shade,--elev";

/**
 * Play the stack from `from` (a snapshot of `[...cards, foot]`) to its
 * current layout.
 *
 * `cards[0]` is the top card, which never moves; `faces` are the cards'
 * contents, faded so a folded sheet reads as blank paper. `foot` isn't
 * tweened at all: every frame it is hung just under the lowest card, and the
 * tray is sized to end just under it. On a clock of its own it either let
 * dealt cards land on it (it left too late) or opened an empty trough under
 * them (it left too early); tied to the cards, neither can happen.
 */
export function flipStack(
  container: HTMLElement,
  cards: readonly HTMLElement[],
  faces: readonly HTMLElement[],
  foot: HTMLElement | null,
  from: StackSnapshot,
  opening: boolean,
): void {
  const everything = [container, ...cards, ...faces, ...(foot ? [foot] : [])];
  // A fold that interrupts an unfold (or the reverse) starts from wherever
  // the cards were mid-flight: `from` was measured with their transforms
  // applied. The old run's inline styles go before measuring where they now
  // land, and killing it drops its clean-up, which would otherwise strip
  // this run's styles when it ended.
  running.get(container)?.kill();
  gsap.set(everything, { clearProps: CLEARED });
  if (prefersReducedMotion()) return;

  const to = snapshotStack(container, foot ? [...cards, foot] : cards);
  // Time grows with the distance the cards cover, up to half again for a
  // tall stack: one fixed duration either dragged a pair of cards or flung
  // ten of them across the page in a blur. Quart, not expo, on the way out:
  // the eye follows a dealt card the whole way, and expo's snap read as a
  // jump.
  const reach = Math.min(1, (cards.length - 2) / 9);
  const duration = opening ? tokens.slow * (1 + 0.5 * reach) : tokens.smooth * (1 + 0.4 * reach);
  const ease = opening ? tokens.easeOutQuart : tokens.easeSoft;
  // A fixed budget spread across however many cards there are keeps a tall
  // stack as quick as a short one.
  const spread = opening ? tokens.stagger.deal : tokens.stagger.gather;

  const tl = gsap.timeline({
    onUpdate: () => hangFoot(container, cards, foot, to),
    onComplete: () => {
      gsap.set(everything, { clearProps: CLEARED });
      running.delete(container);
    },
  });
  running.set(container, tl);

  // Clipped at the bottom while it moves, so a card on its way under can't
  // paint over the row below the stack. Only the bottom: the cards sit flush
  // with the stack's sides, and `overflow: hidden` would shave their shadows
  // off for the length of the fold, then pop them back.
  gsap.set(container, { height: from.height, clipPath: "inset(-1rem -1rem 0 -1rem)" });
  // Each moving card on its own layer for the length of the fold only.
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
      // Dealt top-down, the way cards come off a deck; gathered bottom-up,
      // so the card with the furthest to go sets off first. Their stacking
      // order (the stack's CSS z-index) keeps each one under the card above.
      stagger: { amount: spread, from: opening ? "start" : "end" },
    },
    0,
  );

  // The pile's elevation: dealt cards settle flat over the whole deal;
  // gathered ones turn back into paper in the first half, before they tuck
  // under, since only sheets can stack. Paint only (edges, corners,
  // shadow), so it never moves the layout under the cards.
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

  // A card darkens as it slides under (lower sheets catch less light) and
  // brightens as it is dealt, rather than switching shade on the first frame.
  tl.fromTo(
    cards.slice(1),
    { "--shade": (i: number) => from.shades[i + 1] ?? 0 },
    {
      "--shade": (i: number) => to.shades[i + 1] ?? 0,
      duration,
      ease: tokens.easeSoft,
      stagger: { amount: spread, from: opening ? "start" : "end" },
    },
    0,
  );

  // Sheets past the second are invisible while folded: they arrive out of
  // (and leave into) the second sheet rather than popping.
  const deep = cards.slice(3);
  if (deep.length > 0) {
    tl.fromTo(
      deep,
      { opacity: opening ? 0 : 1 },
      { opacity: opening ? 1 : 0, duration: duration * 0.6, ease: tokens.easeSoft },
      opening ? 0 : duration * 0.4,
    );
  }

  // A face appears once its card has mostly cleared the one above, and goes
  // before its card starts to tuck under.
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

/** The inverse transform that puts piece `i`, laid out at `to`, back where it was in `from`. */
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

/**
 * Hang the foot under the lowest card as it stands this frame, at the gap it
 * keeps at rest, and end the tray the same distance under the foot as it
 * will at rest. Without a foot, the tray alone follows the lowest card.
 *
 * Reads where each card is from GSAP's own `y`, never from the DOM: the
 * cards are laid out at their resting places and only translated, so their
 * resting rect plus `y` is exact, and measuring instead would force a
 * layout on every frame right after this one writes the tray's height.
 */
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
