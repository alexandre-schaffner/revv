/**
 * Public surface of the motion module. Everything callable from app code
 * should be exported here so import paths stay short.
 */
export { gsap, Flip, Observer, Draggable, ScrollTrigger, initGsap } from "./gsap";
export { tokens } from "./tokens";
export {
  withMotion,
  prefersReducedMotion,
  revertAllMotion,
  type MotionConditionFlags,
} from "./match-media";
export * from "./presets";
export * from "./actions";
export * from "./transitions";
export { setupPageTransitions } from "./page-transitions";
