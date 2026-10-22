import type { HunkSmell } from "@revv/shared";
import Broom from "phosphor-svelte/lib/Broom";
import Eyeglasses from "phosphor-svelte/lib/Eyeglasses";
import EyeSlash from "phosphor-svelte/lib/EyeSlash";
import Robot from "phosphor-svelte/lib/Robot";
import Scroll from "phosphor-svelte/lib/Scroll";
import ShieldCheck from "phosphor-svelte/lib/ShieldCheck";
import ShieldWarning from "phosphor-svelte/lib/ShieldWarning";
import TestTube from "phosphor-svelte/lib/TestTube";
import TreeStructure from "phosphor-svelte/lib/TreeStructure";

/** One glyph per first-pass smell, shared by the chip, the lead groups and the diff strip. */
export const SMELL_ICONS: Record<HunkSmell, typeof Broom> = {
  vulnerability: ShieldWarning,
  over_defensive: ShieldCheck,
  silent_failure: EyeSlash,
  slop: Robot,
  over_engineered: TreeStructure,
  hard_to_read: Eyeglasses,
  unclean: Broom,
  verbose_comment: Scroll,
  redundant_test: TestTube,
};
