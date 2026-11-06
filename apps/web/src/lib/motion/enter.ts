/**
 * One-shot entrances.
 *
 *   <div use:enterOnce={{ key: `wt:${id}:block`, look: "rise", cascade: BLOCKS }}>
 *
 * The tween starts the first time the node is laid out, so a node mounted
 * inside a `display: none` tab waits until the tab shows. A played `key` is
 * remembered for the session: remounting the node (switching PRs and back)
 * or re-showing its tab never replays it. A node whose `key` changes to one
 * not yet played plays again, so a state change can carry its own entrance
 * (`key: \`${axis}:${state}\``). Nodes laid out in the same frame under one
 * `cascade.group` stagger in DOM order.
 *
 *   <div use:gsapEnter={{ y: 6, delay: 0.24 }}>
 *
 * `gsapEnter` is the plain version: it plays on mount with ad-hoc offsets, no
 * key, no layout wait. Both tween through `enterFrom`.
 */
import type { Action } from "svelte/action";

import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

interface Look {
  from: gsap.TweenVars;
  duration: number;
  ease: string;
}

const LOOKS = {
  /** Walkthrough blocks and their annotations. */
  rise: {
    from: { opacity: 0, y: 10, filter: "blur(4px)" },
    duration: tokens.ceremonialMedium,
    ease: tokens.easeStandard,
  },
  /** A whole surface: walkthrough body, chapter stepper. */
  surface: { from: { opacity: 0, y: 4 }, duration: tokens.smooth, ease: tokens.easeStandard },
  /** Issue cards. */
  card: {
    from: { opacity: 0, y: 4 },
    duration: tokens.ceremonialMedium,
    ease: tokens.easeStandard,
  },
  /** The issues section, whose cards fade on their own. */
  settle: {
    from: { y: 6, filter: "blur(3px)" },
    duration: tokens.ceremonialMedium,
    ease: tokens.easeStandard,
  },
  row: { from: { opacity: 0, y: 4 }, duration: tokens.ceremonialMedium, ease: tokens.easeOutExpo },
  nudge: { from: { opacity: 0.7, x: -2 }, duration: tokens.quick, ease: tokens.easeOutExpo },
  /** For an overlay whose resting style is `opacity: 0`: a row gutter's glow. */
  flash: { from: { opacity: 1 }, duration: tokens.slow, ease: tokens.easeOutExpo },
  drop: { from: { opacity: 0.6, y: -1 }, duration: tokens.smooth, ease: tokens.easeOutExpo },
  pop: { from: { opacity: 0, scale: 0.85 }, duration: tokens.quick, ease: tokens.easeOutExpo },
} satisfies Record<string, Look>;

export type EnterLook = keyof typeof LOOKS;

export interface EnterCascade {
  group: string;
  /** Seconds between consecutive nodes. */
  step: number;
  /** Nodes past this index share the last delay. */
  cap: number;
  /** Nodes of one group sharing a beat take one step together (a block and its annotation). */
  beat?: string | undefined;
}

export interface EnterParams {
  /** Played once per session. Omit to play on every mount. */
  key?: string | undefined;
  look: EnterLook;
  /** Seconds. */
  delay?: number;
  cascade?: EnterCascade | undefined;
}

const played = new Set<string>();

/** True the first time `key` is asked for: for entrances that run their own timeline. */
export function firstEntrance(key: string): boolean {
  if (played.has(key)) return false;
  played.add(key);
  return true;
}

const waiting = new Map<Element, EnterParams>();
let observer: ResizeObserver | null = null;

interface CascadeCursor {
  next: number;
  beats: Map<string, number>;
}

function cascadeSlot(cascade: EnterCascade, cursors: Map<string, CascadeCursor>): number {
  let cursor = cursors.get(cascade.group);
  if (!cursor) {
    cursor = { next: 0, beats: new Map() };
    cursors.set(cascade.group, cursor);
  }
  const shared = cascade.beat === undefined ? undefined : cursor.beats.get(cascade.beat);
  if (shared !== undefined) return shared;
  const slot = cursor.next++;
  if (cascade.beat !== undefined) cursor.beats.set(cascade.beat, slot);
  return slot;
}

function propsSetBy(from: gsap.TweenVars): string {
  const props: string[] = [];
  if (from.opacity !== undefined) props.push("opacity");
  if (from.x !== undefined || from.y !== undefined || from.scale !== undefined) {
    props.push("transform");
  }
  if (from.filter !== undefined) props.push("filter");
  return props.join(",");
}

/**
 * Clears what the tween set when it ends. A leftover inline transform/filter
 * keeps the node on its own compositing layer (a long walkthrough then runs WKWebView out of layer budget and tiles
 * flicker), and a transform makes it a containing block for its
 * `position: fixed` descendants.
 */
function enterFrom(
  node: Element,
  from: gsap.TweenVars,
  timing: { duration: number; ease: string; delay: number },
): gsap.core.Tween {
  return gsap.from(node, { ...from, ...timing, clearProps: propsSetBy(from) });
}

function play(node: Element, params: EnterParams, cursors: Map<string, CascadeCursor>): void {
  if (params.key !== undefined && !firstEntrance(params.key)) return;
  if (prefersReducedMotion()) return;
  const look: Look = LOOKS[params.look];
  let delay = params.delay ?? 0;
  if (params.cascade) {
    const { step, cap } = params.cascade;
    delay += Math.min(cascadeSlot(params.cascade, cursors), cap) * step;
  }
  enterFrom(node, look.from, { duration: look.duration, ease: look.ease, delay });
}

function onLayout(entries: ResizeObserverEntry[]): void {
  const cursors = new Map<string, CascadeCursor>();
  for (const { target } of entries) {
    const params = waiting.get(target);
    if (!params || target.getClientRects().length === 0) continue;
    waiting.delete(target);
    observer?.unobserve(target);
    play(target, params, cursors);
  }
}

function awaitLayout(node: Element, params: EnterParams | undefined): void {
  if (!params || (params.key !== undefined && played.has(params.key))) return;
  waiting.set(node, params);
  observer ??= new ResizeObserver(onLayout);
  observer.observe(node);
}

/** `undefined` params: no entrance. */
export const enterOnce: Action<HTMLElement, EnterParams | undefined> = (node, params) => {
  let key = params?.key;
  awaitLayout(node, params);
  return {
    update(next: EnterParams | undefined) {
      if (waiting.has(node) && next) waiting.set(node, next);
      else if (next?.key !== key) awaitLayout(node, next);
      key = next?.key;
    },
    destroy() {
      if (waiting.delete(node)) observer?.unobserve(node);
      gsap.killTweensOf(node);
    },
  };
};

export interface MountEnterParams {
  /** Rise from this many px below (negative: drop from above). */
  readonly y?: number;
  readonly scale?: number;
  /** Start blurred by this many px. */
  readonly blur?: number;
  /** Fade in from transparent. Default true. */
  readonly fade?: boolean;
  /** Seconds. Default `tokens.ceremonialMedium`. */
  readonly duration?: number;
  /** Seconds; the element stays at its start state until then. */
  readonly delay?: number;
}

/** Plays once on mount; later parameter changes don't replay it. */
export const gsapEnter: Action<HTMLElement, MountEnterParams | undefined> = (node, params = {}) => {
  if (prefersReducedMotion()) return;
  const { y, scale, blur, fade = true, duration = tokens.ceremonialMedium, delay = 0 } = params;
  const from: gsap.TweenVars = {};
  if (fade) from.opacity = 0;
  if (y !== undefined) from.y = y;
  if (scale !== undefined) from.scale = scale;
  if (blur !== undefined) from.filter = `blur(${blur}px)`;
  const tween = enterFrom(node, from, { duration, ease: tokens.easeOutExpo, delay });
  return {
    destroy() {
      tween.kill();
    },
  };
};

/**
 * Draw the eye to a node the user just jumped to: its outline flashes the
 * accent, holds, and fades. The node's CSS paints the outline from
 * `--jump-highlight` (0–1), because GSAP can't interpolate `color-mix()`.
 */
export function pulseHighlight(node: HTMLElement): void {
  if (prefersReducedMotion()) return;
  gsap.fromTo(
    node,
    { "--jump-highlight": 1 },
    {
      "--jump-highlight": 0,
      delay: tokens.ceremonialSlow * 0.7,
      duration: tokens.ceremonialSlow * 0.3,
      ease: tokens.easeSoft,
      clearProps: "--jump-highlight",
    },
  );
}
