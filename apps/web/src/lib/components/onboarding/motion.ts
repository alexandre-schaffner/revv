import { type MountEnterParams, tokens } from "$lib/motion";

// The onboarding steps' shared entrances (see `gsapEnter`).

/** A choice row rising into a list; stagger with `delay`. */
export const OPTION_IN: MountEnterParams = { y: 6 };

/** A step's action row, after its content. */
export const ACTIONS_IN: MountEnterParams = { y: 6, delay: 0.24 };

/** A radio's dot popping in when it's picked. */
export const MARK_POP: MountEnterParams = { scale: 0, fade: false, duration: tokens.slow };
