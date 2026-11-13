// Writes apps/web/src/lib/motion/tokens.ts from the motion variables in the
// `@theme` block of apps/web/src/app.css, so GSAP and CSS read one source.
// `--check` fails instead of writing when the file is out of date.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const webSrc = join(import.meta.dir, "../apps/web/src");
const cssPath = join(webSrc, "app.css");
const tokensPath = join(webSrc, "lib/motion/tokens.ts");

const css = readFileSync(cssPath, "utf8");
const themeStart = css.indexOf("@theme {");
if (themeStart === -1) throw new Error("app.css has no `@theme {` block.");
const theme = css.slice(themeStart, css.indexOf("\n}", themeStart));

const camel = (kebab: string) => kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function seconds(name: string, value: string): string {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
  if (!match?.[1]) throw new Error(`${name}: expected a duration in ms or s, got "${value}".`);
  const n = Number(match[1]);
  return String(match[2] === "ms" ? Number((n / 1000).toFixed(6)) : n);
}

function controlPoints(name: string, value: string): string {
  const match = /^cubic-bezier\(([^)]*)\)$/.exec(value);
  if (!match?.[1]) throw new Error(`${name}: expected cubic-bezier(...), got "${value}".`);
  return JSON.stringify(
    match[1]
      .split(",")
      .map((p) => p.trim())
      .join(", "),
  );
}

const durations: string[] = [];
const eases: string[] = [];
const staggers: string[] = [];
for (const [, name = "", raw = ""] of theme.matchAll(
  /^\s*--((?:duration|ease|stagger)-[\w-]+):\s*([^;]+);/gm,
)) {
  const value = raw.trim();
  if (name.startsWith("duration-")) {
    durations.push(`  ${camel(name.slice("duration-".length))}: ${seconds(name, value)},`);
  } else if (name.startsWith("ease-")) {
    eases.push(`  ${camel(name)}: ${controlPoints(name, value)},`);
  } else {
    staggers.push(`    ${camel(name.slice("stagger-".length))}: ${seconds(name, value)},`);
  }
}

const generated = `// Generated from the \`@theme\` block in src/app.css by \`bun run gen:motion-tokens\`.
// Edit app.css and regenerate; \`bun run lint\` fails while the two disagree.

/**
 * Motion tokens for GSAP: durations and staggers in seconds, eases as bare
 * cubic-bezier control points (CustomEase parses any string starting with a
 * digit).
 */
export const tokens = {
${durations.join("\n")}

${eases.join("\n")}

  stagger: {
${staggers.join("\n")}
  },
} as const;
`;

if (process.argv.includes("--check")) {
  if (readFileSync(tokensPath, "utf8") !== generated) {
    console.error(
      "apps/web/src/lib/motion/tokens.ts is out of date with app.css. Run `bun run gen:motion-tokens`.",
    );
    process.exit(1);
  }
  console.log("Motion tokens match app.css.");
} else {
  writeFileSync(tokensPath, generated);
}
