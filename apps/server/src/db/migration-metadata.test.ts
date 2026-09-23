import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT_ID = "00000000-0000-0000-0000-000000000000";
const metaDirectory = join(import.meta.dir, "migrations", "meta");

const snapshotSchema = z.object({
  id: z.string().regex(UUID),
  prevId: z.string().regex(UUID),
});

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int().nonnegative() })),
});

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

const snapshots = readdirSync(metaDirectory)
  .filter((file) => /^\d{4}_snapshot\.json$/.test(file))
  .sort()
  .map((file) => ({
    file,
    index: Number.parseInt(file.slice(0, 4), 10),
    ...snapshotSchema.parse(readJson(join(metaDirectory, file))),
  }));

describe("Drizzle migration metadata", () => {
  it("forms one linear snapshot chain without parent collisions", () => {
    const ids = new Set(snapshots.map((snapshot) => snapshot.id));
    expect(ids.size).toBe(snapshots.length);

    const roots = snapshots.filter((snapshot) => snapshot.prevId === ROOT_ID);
    expect(roots).toHaveLength(1);

    const childrenByParent = new Map<string, string[]>();
    for (const snapshot of snapshots) {
      if (snapshot.prevId === ROOT_ID) continue;
      expect(ids.has(snapshot.prevId)).toBe(true);
      const children = childrenByParent.get(snapshot.prevId) ?? [];
      children.push(snapshot.id);
      childrenByParent.set(snapshot.prevId, children);
    }
    for (const children of childrenByParent.values()) {
      expect(children).toHaveLength(1);
    }

    let current = roots[0];
    let visited = 0;
    while (current) {
      visited += 1;
      const childId = childrenByParent.get(current.id)?.[0];
      current = childId ? snapshots.find((snapshot) => snapshot.id === childId) : undefined;
    }
    expect(visited).toBe(snapshots.length);
  });

  it("uses journal indices for snapshot filenames and snapshots the latest migration", () => {
    const journal = journalSchema.parse(readJson(join(metaDirectory, "_journal.json")));
    const journalIndices = new Set(journal.entries.map((entry) => entry.idx));
    for (const snapshot of snapshots) {
      expect(journalIndices.has(snapshot.index)).toBe(true);
    }

    const latestEntry = journal.entries.at(-1);
    const latestSnapshot = snapshots.at(-1);
    expect(latestEntry).toBeDefined();
    expect(latestSnapshot).toBeDefined();
    expect(latestSnapshot?.index).toBe(latestEntry?.idx);
  });
});
