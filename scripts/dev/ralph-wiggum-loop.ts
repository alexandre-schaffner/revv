#!/usr/bin/env bun
/**
 * Ralph Wiggum Loop — Audit Fix Automation
 *
 * Reads an audit PRD, confirms each finding in the actual source code,
 * applies the minimal safe fix, and verifies with typecheck / lint.
 *
 * Usage:
 *   bun run scripts/dev/ralph-wiggum-loop.ts docs/audits/prd-security-hardening.md
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { $ } from "bun";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface UserStory {
  id: string;
  title: string;
  fileRefs: string[];
  checks: string[];
}

interface FixResult {
  storyId: string;
  confirmed: boolean;
  fixed: boolean;
  error?: string;
  diff?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD Parser
// ─────────────────────────────────────────────────────────────────────────────

function parsePrd(markdown: string): UserStory[] {
  const stories: UserStory[] = [];
  const storyRegex = /### (US-\d+):\s*(.+?)\n[\s\S]*?(?=### US-\d+|## |$)/g;

  for (const match of markdown.matchAll(storyRegex)) {
    const [, id, title] = match;
    const block = match[0];

    // Extract file references from acceptance criteria
    const fileRefs: string[] = [];
    const fileRegex = /`([^`]+\.(?:ts|svelte|tsx|json|rs))`/g;
    for (const fileMatch of block.matchAll(fileRegex)) {
      const path = fileMatch[1];
      if (!fileRefs.includes(path)) fileRefs.push(path);
    }

    // Extract check items
    const checks: string[] = [];
    const checkRegex = /- \[ \]\s*(.+)/g;
    for (const checkMatch of block.matchAll(checkRegex)) {
      checks.push(checkMatch[1].trim());
    }

    stories.push({ id, title: title.trim(), fileRefs, checks });
  }

  return stories;
}

// ─────────────────────────────────────────────────────────────────────────────
// File helpers
// ─────────────────────────────────────────────────────────────────────────────

async function readSrcFile(relPath: string): Promise<string | null> {
  try {
    return await readFile(relPath, "utf-8");
  } catch {
    return null;
  }
}

function writeSrcFile(relPath: string, content: string): Promise<void> {
  return writeFile(relPath, content, "utf-8");
}

function computeDiff(original: string, modified: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const diff: string[] = [];
  let i = 0;
  while (i < Math.max(origLines.length, modLines.length)) {
    if (i >= origLines.length) {
      diff.push(`+ ${modLines[i]}`);
    } else if (i >= modLines.length) {
      diff.push(`- ${origLines[i]}`);
    } else if (origLines[i] !== modLines[i]) {
      diff.push(`- ${origLines[i]}`);
      diff.push(`+ ${modLines[i]}`);
    }
    i++;
  }
  return diff.slice(0, 30).join("\n"); // cap diff size
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmers — check if the bug still exists
// ─────────────────────────────────────────────────────────────────────────────

const CONFIRMERS: Record<string, (content: string) => boolean> = {
  // US-001: CORS regex
  "US-001": (src) => src.includes("origin: /localhost/"),

  // US-002: WS token in query string (web)
  "US-002": (src) =>
    src.includes("ws?token=") || (src.includes("WS_BASE_URL") && src.includes("token=")),

  // US-003: githubHost validation
  "US-003": (src) =>
    !src.includes("InvalidGitHubHostError") &&
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal — searching for this exact text in source code
    (src.includes("api.${host}") || src.includes("githubHost")),

  // US-004: path validation in RepoClone
  "US-004": (src) => src.includes("runGitCapture") && !src.includes("assertSafePath"),

  // US-005: WS unresolved account
  "US-005": (src) => src.includes('accountId = "unresolved"'),

  // US-006: Error sanitization
  "US-006": (src) =>
    src.includes("return { error: message }") &&
    src.includes("const message = e instanceof Error ? e.message"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixers — apply the minimal safe change
// ─────────────────────────────────────────────────────────────────────────────

const FIXERS: Record<string, (src: string) => string | null> = {
  // US-001: Replace regex CORS with explicit allowlist
  "US-001": (src) => {
    if (!src.includes("origin: /localhost/")) return null;
    return src.replace(
      /origin: \/localhost\//,
      'origin: ["http://localhost:5173", "http://localhost:45678", "tauri://localhost"]',
    );
  },

  // US-005: Close WS on unresolved account instead of allowing it
  "US-005": (src) => {
    if (!src.includes('accountId = "unresolved"')) return null;
    // Find the exact catch block that sets accountId = "unresolved"
    const catchStart = src.indexOf('accountId = "unresolved"');
    if (catchStart === -1) return null;

    // Walk backward to find "catch {"
    const catchBlockStart = src.lastIndexOf("catch {", catchStart);
    if (catchBlockStart === -1) return null;

    // Walk forward to find the closing "}"
    let braceDepth = 0;
    let catchBlockEnd = catchBlockStart;
    for (let i = catchBlockStart; i < src.length; i++) {
      if (src[i] === "{") braceDepth++;
      if (src[i] === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          catchBlockEnd = i + 1;
          break;
        }
      }
    }

    const before = src.slice(0, catchBlockStart);
    const after = src.slice(catchBlockEnd);
    const replacement = `catch {
      ws.close(4001, "Unauthorized");
      return;
    }`;

    return before + replacement + after;
  },

  // US-006: Sanitize unknown error responses
  "US-006": (src) => {
    if (!src.includes("return { error: message }")) return null;
    return src.replace(
      /\/\/ Unknown error.*?logError\("handleAppError", "unhandled error:", message\);[\s\S]*?return \{ error: message \};/,
      `// Unknown error — log full details server-side, return generic message to client.
  const message = e instanceof Error ? e.message : "Internal server error";
  logError("handleAppError", "unhandled error:", message, e);
  ctx.set.status = 500;
  return { error: "Internal server error" };`,
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

function getPackageDir(filePath: string): string {
  if (filePath.startsWith("apps/server/")) return "apps/server";
  if (filePath.startsWith("apps/web/")) return "apps/web";
  if (filePath.startsWith("apps/desktop/")) return "apps/desktop";
  if (filePath.startsWith("packages/")) return filePath.split("/").slice(0, 2).join("/");
  return ".";
}

async function verifyTypecheckOnFile(filePath: string): Promise<boolean> {
  const packageDir = getPackageDir(filePath);
  console.log(`  → running typecheck (scoped to ${packageDir})…`);

  // Run tsc --noEmit in the package directory
  const proc = await $`cd ${packageDir} && bunx tsc --noEmit`.quiet().nothrow();
  const output = proc.stdout.toString() + proc.stderr.toString();

  // Check if any error references our modified file
  const hasErrorInFile = output.includes(filePath);
  if (hasErrorInFile) {
    console.log(`  ⚠️  Type error in ${filePath}:`);
    const errorLines = output.split("\n").filter((l) => l.includes(filePath));
    console.log(errorLines.map((l) => `     ${l}`).join("\n"));
    return false;
  }

  // If tsc exited non-zero but not due to our file, that's a pre-existing issue — warn but don't fail
  if (proc.exitCode !== 0) {
    console.log(
      `  ⚠️  Typecheck exited non-zero, but no errors in ${filePath} (pre-existing issues in other files).`,
    );
  }
  return true;
}

async function verifyLintOnFiles(files: string[]): Promise<boolean> {
  console.log(`  → running lint on ${files.join(", ")}…`);
  const proc = await $`biome check ${files} --no-errors-on-unmatched`.quiet().nothrow();
  return proc.exitCode === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const prdPath = process.argv[2];
  if (!prdPath) {
    console.error("Usage: bun run scripts/dev/ralph-wiggum-loop.ts <path-to-prd.md>");
    process.exit(1);
  }

  console.log(`\n🍭 Ralph Wiggum Loop — ${basename(prdPath)}\n`);

  const markdown = await readFile(prdPath, "utf-8");
  const stories = parsePrd(markdown);

  if (stories.length === 0) {
    console.error("No user stories found in PRD.");
    process.exit(1);
  }

  console.log(`Found ${stories.length} user stories.\n`);

  const results: FixResult[] = [];
  const modifiedFiles = new Set<string>();

  for (const story of stories) {
    console.log(`── ${story.id}: ${story.title} ──`);

    // Determine which file to patch (heuristic: first file ref, or skip if no fixer)
    const targetFile = story.fileRefs[0];
    if (!targetFile) {
      console.log("  ⚠️  No file reference found — skipping.\n");
      results.push({ storyId: story.id, confirmed: false, fixed: false, error: "No file ref" });
      continue;
    }

    const confirmer = CONFIRMERS[story.id];
    const fixer = FIXERS[story.id];

    if (!confirmer || !fixer) {
      console.log(`  ⚠️  No automated confirmer/fixer for ${story.id} — manual fix required.\n`);
      results.push({ storyId: story.id, confirmed: false, fixed: false, error: "No automation" });
      continue;
    }

    const original = await readSrcFile(targetFile);
    if (!original) {
      console.log(`  ⚠️  Could not read ${targetFile} — skipping.\n`);
      results.push({ storyId: story.id, confirmed: false, fixed: false, error: "File not found" });
      continue;
    }

    // Confirm finding
    const confirmed = confirmer(original);
    if (!confirmed) {
      console.log(`  ✅ Finding already resolved (not present in ${targetFile}).\n`);
      results.push({ storyId: story.id, confirmed: false, fixed: true });
      continue;
    }
    console.log(`  🔍 Confirmed: bug present in ${targetFile}`);

    // Apply fix
    const modified = fixer(original);
    if (!modified || modified === original) {
      console.log(`  ⚠️  Fixer produced no change — manual fix required.\n`);
      results.push({ storyId: story.id, confirmed: true, fixed: false, error: "Fixer no-op" });
      continue;
    }

    const diff = computeDiff(original, modified);
    console.log(
      `  📝 Diff preview:\n${diff
        .split("\n")
        .map((l) => `     ${l}`)
        .join("\n")}\n`,
    );

    await writeSrcFile(targetFile, modified);
    modifiedFiles.add(targetFile);
    console.log(`  💾 Wrote fix to ${targetFile}`);

    // Verify — only lint the files we modified; typecheck scoped to package
    const typeOk = await verifyTypecheckOnFile(targetFile);
    const lintOk = await verifyLintOnFiles([targetFile]);

    if (typeOk && lintOk) {
      console.log(`  ✅ Typecheck + lint pass.\n`);
      results.push({ storyId: story.id, confirmed: true, fixed: true, diff });
    } else {
      // Rollback on verification failure
      await writeSrcFile(targetFile, original);
      console.log(`  ❌ Verification failed — rolled back ${targetFile}.\n`);
      results.push({
        storyId: story.id,
        confirmed: true,
        fixed: false,
        error: `Typecheck: ${typeOk}, Lint: ${lintOk}`,
        diff,
      });
    }
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("                         SUMMARY                                   ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const fixed = results.filter((r) => r.fixed);
  const failed = results.filter((r) => !r.fixed && r.confirmed);
  const skipped = results.filter((r) => !r.fixed && !r.confirmed && !r.error);
  const manual = results.filter((r) => r.error === "No automation" || r.error === "Fixer no-op");

  console.log(`  ✅ Auto-fixed:     ${fixed.length}`);
  console.log(`  ❌ Failed (rolled back): ${failed.length}`);
  console.log(`  ⏭️  Already resolved: ${skipped.length}`);
  console.log(`  ✋ Manual required: ${manual.length}\n`);

  for (const r of failed) {
    console.log(`  ❌ ${r.storyId} — ${r.error}`);
  }
  for (const r of manual) {
    console.log(`  ✋ ${r.storyId} — ${r.error}`);
  }

  if (modifiedFiles.size > 0) {
    console.log(`\n  Modified files: ${Array.from(modifiedFiles).join(", ")}`);
  }

  console.log("\n🍭 Ralph is done.\n");

  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
