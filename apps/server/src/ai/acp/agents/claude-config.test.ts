import { describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeConfigDir } from "./claude-config";

describe("ensureClaudeConfigDir", () => {
  it("creates the dir (mode 0700) and seeds an onboarding-only .claude.json", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const dir = join(base, "claude");
    try {
      ensureClaudeConfigDir(dir, join(base, "global"));

      expect(existsSync(dir)).toBe(true);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);

      const onboardingPath = join(dir, ".claude.json");
      expect(existsSync(onboardingPath)).toBe(true);
      expect(JSON.parse(readFileSync(onboardingPath, "utf8"))).toEqual({
        hasCompletedOnboarding: true,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second call on an already-seeded dir is a no-op", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const dir = join(base, "claude");
    try {
      ensureClaudeConfigDir(dir, join(base, "global"));
      const onboardingPath = join(dir, ".claude.json");
      // Simulate the CLI having since rewritten its own state into the file —
      // a second `ensureClaudeConfigDir` call must not clobber it.
      writeFileSync(
        onboardingPath,
        JSON.stringify({ hasCompletedOnboarding: true, extra: "cli-state" }),
      );

      ensureClaudeConfigDir(dir, join(base, "global"));

      expect(JSON.parse(readFileSync(onboardingPath, "utf8"))).toEqual({
        hasCompletedOnboarding: true,
        extra: "cli-state",
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never throws when the dir can't be created", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const file = join(base, "not-a-dir");
    try {
      writeFileSync(file, "");
      expect(() => ensureClaudeConfigDir(join(file, "claude"), join(base, "global"))).not.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // Revv's `/` menu must offer the same skills as the user's `claude` in a
  // terminal, while the session registry stays unlinked — that's what
  // isolation is for.
  it("links the user's auth + toolbox and nothing from the session registry", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const globalDir = join(base, "global");
    const dir = join(base, "claude");
    try {
      for (const entry of ["skills", "commands", "agents", "plugins", "projects", "sessions"]) {
        mkdirSync(join(globalDir, entry), { recursive: true });
      }
      writeFileSync(join(globalDir, ".credentials.json"), "{}");
      writeFileSync(join(globalDir, "CLAUDE.md"), "# user memory");
      writeFileSync(join(globalDir, "settings.json"), "{}");

      ensureClaudeConfigDir(dir, globalDir);

      for (const entry of [
        ".credentials.json",
        "skills",
        "commands",
        "agents",
        "plugins",
        "CLAUDE.md",
      ]) {
        expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true);
      }
      for (const entry of ["projects", "sessions", "settings.json"]) {
        expect(existsSync(join(dir, entry))).toBe(false);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("skips entries the user doesn't have and never replaces an existing one", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const globalDir = join(base, "global");
    const dir = join(base, "claude");
    try {
      mkdirSync(join(globalDir, "skills"), { recursive: true });
      mkdirSync(join(globalDir, "commands"), { recursive: true });
      // A real dir the CLI already wrote into the isolated config is left
      // as-is, not clobbered.
      mkdirSync(join(dir, "commands"), { recursive: true });

      ensureClaudeConfigDir(dir, globalDir);

      expect(lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(dir, "commands")).isSymbolicLink()).toBe(false);
      for (const entry of ["agents", "plugins", "CLAUDE.md"]) {
        expect(existsSync(join(dir, entry))).toBe(false);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // Claude Code reads `enabledPlugins` from `settings.json`; without it a
  // linked `plugins/` enables nothing.
  it("copies enabledPlugins into the isolated settings.json and keeps its other keys", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const globalDir = join(base, "global");
    const dir = join(base, "claude");
    try {
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(globalDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "pstack@cursor-plugins": true }, hooks: { Stop: [] } }),
      );
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "old@market": true }, model: "opus" }),
      );

      ensureClaudeConfigDir(dir, globalDir);

      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({
        enabledPlugins: { "pstack@cursor-plugins": true },
        model: "opus",
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never writes through a settings.json the user linked by hand", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const globalDir = join(base, "global");
    const dir = join(base, "claude");
    try {
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(dir, { recursive: true });
      const shared = join(base, "shared-settings.json");
      writeFileSync(shared, JSON.stringify({ theme: "dark" }));
      symlinkSync(shared, join(dir, "settings.json"));
      writeFileSync(
        join(globalDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "pstack@cursor-plugins": true } }),
      );

      ensureClaudeConfigDir(dir, globalDir);

      expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(shared, "utf8"))).toEqual({ theme: "dark" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
