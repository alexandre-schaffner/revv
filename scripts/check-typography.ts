// Every font size, family and weight in apps/web comes from the type system in
// app.css: sizes are `--text-*` steps, families are the three `--font-*`
// stacks, weights are 400 / 500 / 600. This keeps the scale from drifting back
// into the half-pixel literals it replaced.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../apps/web/src");
const theme = readFileSync(join(root, "app.css"), "utf8");
const steps = new Set(
  [...theme.matchAll(/^\s*--text-([\w-]+):/gm)]
    .map((match) => match[1] ?? "")
    .filter((name) => !name.includes("--") && !name.startsWith("shimmer")),
);

const utils = readFileSync(join(root, "lib/utils.ts"), "utf8");
const merged = new Set(utils.match(/text:\s*\[([^\]]*)\]/)?.[1]?.match(/[\w-]+/g) ?? []);
const STOCK = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"]);

// Sizes that scale with a box (avatar initials) or the window (the onboarding
// hero) rather than sit on the type scale, and the one graphic that is ink,
// not type.
const EXEMPT_SIZE = new Set([
  "lib/components/shared/Avatar.svelte",
  "lib/components/shared/RepoGradientAvatar.svelte",
  "lib/components/onboarding/OnboardingShell.svelte",
]);
const EXEMPT_WEIGHT = new Set(["lib/components/walkthrough/MergedStamp.svelte"]);

const failures: string[] = [];
for (const step of steps) {
  if (!STOCK.has(step) && !merged.has(step)) {
    failures.push(`lib/utils.ts: register --text-${step} with tailwind-merge (twMergeConfig).`);
  }
}

function sizeOk(value: string): boolean {
  if (value === "inherit") return true;
  if (/^\d*\.?\d+em$/.test(value)) return true; // relative to the parent step
  const token = value.match(/^var\(--text-([\w-]+)\)$/)?.[1];
  return token !== undefined && steps.has(token);
}

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fonts") walk(path);
      continue;
    }
    if (!/\.(svelte|css)$/.test(entry.name)) continue;
    const file = relative(root, path);
    // Blank comments so prose about a rule doesn't read as the rule.
    const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (c) =>
      c.replace(/[^\n]/g, " "),
    );
    const line = (index: number) => source.slice(0, index).split("\n").length;
    const fail = (index: number, found: string, fix: string) =>
      failures.push(`${file}:${line(index)}: ${found.trim()}. ${fix}`);

    for (const m of source.matchAll(/font-size:\s*([^;\n}]+)/g)) {
      const value = (m[1] ?? "").replace(/\s*!important$/, "").trim();
      if (!sizeOk(value) && !EXEMPT_SIZE.has(file)) {
        fail(m.index, m[0], "Use a --text-* step from app.css.");
      }
    }
    for (const m of source.matchAll(/font-family:\s*([^;\n}]+)/g)) {
      const value = (m[1] ?? "").trim();
      if (!/^var\(--font-(sans|mono|serif)\)$/.test(value) && value !== "inherit") {
        fail(m.index, m[0], "Use var(--font-sans), var(--font-mono) or var(--font-serif).");
      }
    }
    for (const m of source.matchAll(/font-weight:\s*([^;\n}]+)/g)) {
      const value = (m[1] ?? "").replace(/\s*!important$/, "").trim();
      const ok = /^(400|500|600|inherit|100 900)$/.test(value) || value.startsWith("var(--shiki");
      if (!ok && !EXEMPT_WEIGHT.has(file)) {
        fail(m.index, m[0], "Use 400 (text), 500 (controls, display) or 600 (emphasis).");
      }
    }
    if (!file.endsWith(".svelte")) continue;
    for (const m of source.matchAll(/(?<![\w-])text-\[(?:length:)?\d[^\]]*\]/g)) {
      fail(m.index, m[0], "Use a text-* step (text-3xs … text-5xl).");
    }
    for (const m of source.matchAll(
      /(?<![\w-])font-(?:thin|extralight|light|bold|extrabold|black)(?![\w-])/g,
    )) {
      fail(m.index, m[0], "Use font-normal, font-medium or font-semibold.");
    }
  }
}

walk(root);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} typography violation(s).`);
  process.exit(1);
}
console.log("Typography: every size, family and weight comes from the type system.");
