// ─── Skill Registry ──────────────────────────────────────────────────────────
//
// Composable, type-safe prompt fragments that teach the agent a craft, style,
// or discipline without overlapping with workflow / tool instructions.
//
// Usage:
//   import { loadSkills } from "../skills/registry";
//   const systemPrompt = BASE_PROMPT + "\n\n" + loadSkills(["beautiful-markdown"]);
//
// Future path:
//   - Add SkillName entries as new .md files are introduced.
//   - Wire `enabledSkills` through UserSettings and agent runners to let users
//     toggle skills per-task.

import { readFileSync } from "node:fs";

/** Known composable skills. Each maps to a self-contained markdown document. */
export type SkillName = "beautiful-markdown";

const SKILL_LOADERS: Record<SkillName, () => string> = {
  "beautiful-markdown": () => readFileSync(`${import.meta.dir}/beautiful-markdown.md`, "utf-8"),
};

/**
 * Load skills by name, joining with a separator. Unknown names fail fast at
 * runtime (the Record typing catches them at compile time).
 */
export function loadSkills(names: readonly SkillName[], opts?: { separator?: string }): string {
  const sep = opts?.separator ?? "\n\n";
  return names.map((n) => SKILL_LOADERS[n]()).join(sep);
}
