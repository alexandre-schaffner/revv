import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LEGACY_UPGRADES, SUPPORT_FLOOR } from "./upgrades";

const repoRoot = join(import.meta.dir, "../../..");
const MARKER = /legacy-upgrade: (\w+)/g;

function semver(version: string): number[] {
  return version.split(".").map(Number);
}

function newer(a: string, b: string): boolean {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function sourceFiles(dir: string, include: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" ? [] : sourceFiles(path, include);
    }
    return include.test(name) ? [path] : [];
  });
}

describe("legacy upgrades ledger", () => {
  it("holds only upgrades some supported release still needs", () => {
    for (const [key, upgrade] of Object.entries(LEGACY_UPGRADES)) {
      expect({ key, needed: newer(upgrade.introducedIn, SUPPORT_FLOOR) }).toEqual({
        key,
        needed: true,
      });
    }
  });

  it("matches the legacy-upgrade markers in the code, both ways", () => {
    const markers = new Map<string, Set<string>>();
    for (const file of [
      ...sourceFiles(join(repoRoot, "apps/server/src"), /\.ts$/),
      ...sourceFiles(join(repoRoot, "apps/desktop/src"), /\.rs$/),
      // The installer and the `revv` CLI carry installs forward too.
      ...sourceFiles(join(repoRoot, "scripts"), /^(revv|.*\.(ts|sh))$/),
    ]) {
      for (const [, key] of readFileSync(file, "utf8").matchAll(MARKER)) {
        if (!key) continue;
        const files = markers.get(key) ?? new Set();
        files.add(relative(repoRoot, file));
        markers.set(key, files);
      }
    }
    const entries = Object.entries(LEGACY_UPGRADES);
    expect([...markers.keys()].sort()).toEqual(entries.map(([key]) => key).sort());
    for (const [key, upgrade] of entries) {
      expect({ key, sites: [...(markers.get(key) ?? [])].sort() }).toEqual({
        key,
        sites: [...upgrade.sites].sort(),
      });
    }
  });
});
