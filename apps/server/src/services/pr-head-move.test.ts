import { describe, expect, it } from "bun:test";
import { isTrustedHeadShaMove, preserveHeadOnStaleRead } from "./pr-head-move";

// ── isTrustedHeadShaMove ─────────────────────────────────────────────────────
// Guards the destructive half of the poll: a head-SHA "move" reported by a
// stale list read used to cancel + supersede the walkthrough generating at the
// real head.

describe("isTrustedHeadShaMove", () => {
  const OLD = "cc7d62fc2a837efe9f953ffa1e48ff72be280d6f";
  const NEW = "c5f7ac2d519f9494f19af19f7ba2a758f8a3fda5";

  it("accepts a forward move", () => {
    expect(
      isTrustedHeadShaMove(
        { headSha: OLD, updatedAt: "2026-09-07T09:00:00Z" },
        { headSha: NEW, updatedAt: "2026-09-07T09:05:00Z" },
      ),
    ).toBe(true);
  });

  it("rejects a stale read that regresses the head", () => {
    expect(
      isTrustedHeadShaMove(
        { headSha: NEW, updatedAt: "2026-09-07T09:05:00Z" },
        { headSha: OLD, updatedAt: "2026-09-07T09:00:00Z" },
      ),
    ).toBe(false);
  });

  it("rejects a payload with no head SHA", () => {
    expect(
      isTrustedHeadShaMove(
        { headSha: OLD, updatedAt: "2026-09-07T09:00:00Z" },
        { headSha: null, updatedAt: "2026-09-07T09:05:00Z" },
      ),
    ).toBe(false);
  });

  it("reports no move when the SHAs agree", () => {
    expect(
      isTrustedHeadShaMove(
        { headSha: NEW, updatedAt: "2026-09-07T09:00:00Z" },
        { headSha: NEW, updatedAt: "2026-09-07T09:05:00Z" },
      ),
    ).toBe(false);
  });

  it("accepts a move with an equal timestamp (two pushes in the same second)", () => {
    expect(
      isTrustedHeadShaMove(
        { headSha: OLD, updatedAt: "2026-09-07T09:05:00Z" },
        { headSha: NEW, updatedAt: "2026-09-07T09:05:00Z" },
      ),
    ).toBe(true);
  });

  it("accepts the first head SHA we ever see, whatever the timestamps say", () => {
    expect(
      isTrustedHeadShaMove(
        { headSha: null, updatedAt: "2026-09-07T09:05:00Z" },
        { headSha: NEW, updatedAt: "2026-09-07T09:00:00Z" },
      ),
    ).toBe(true);
  });
});

// ── preserveHeadOnStaleRead ──────────────────────────────────────────────────
// The write-side half of the same guard. Gating only the supersede left the
// upsert free to write the stale head *and* the older `updated_at`, which then
// re-opened the gate on the following cycle.

describe("preserveHeadOnStaleRead", () => {
  const OLD = "cc7d62fc2a837efe9f953ffa1e48ff72be280d6f";
  const NEW = "c5f7ac2d519f9494f19af19f7ba2a758f8a3fda5";
  const BASE_OLD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const BASE_NEW = "8765432109f8e7d6c5b4a3928170f6e5d4c3b2a1";
  const T1 = "2026-09-07T09:00:00Z";
  const T2 = "2026-09-07T09:05:00Z";

  const stored = { headSha: NEW, baseSha: BASE_NEW, updatedAt: T2 };

  it("keeps the stored head and timestamp when the payload is provably older", () => {
    const fresh = { headSha: OLD, baseSha: BASE_NEW, updatedAt: T1, title: "still written" };
    expect(preserveHeadOnStaleRead(stored, fresh)).toEqual({
      headSha: NEW,
      baseSha: BASE_NEW,
      updatedAt: T2,
      title: "still written",
    });
  });

  // The range is read as a pair: masking the head while writing the stale
  // body's base yields `(BASE_OLD, NEW)`, a diff range neither side reported.
  it("keeps the stored base alongside the stored head", () => {
    const fresh = { headSha: OLD, baseSha: BASE_OLD, updatedAt: T1 };
    expect(preserveHeadOnStaleRead(stored, fresh)).toEqual({
      headSha: NEW,
      baseSha: BASE_NEW,
      updatedAt: T2,
    });
  });

  it("keeps the stored head when the payload carries none", () => {
    expect(
      preserveHeadOnStaleRead(stored, { headSha: null, baseSha: BASE_OLD, updatedAt: T1 }),
    ).toEqual({
      headSha: NEW,
      baseSha: BASE_NEW,
      updatedAt: T2,
    });
  });

  it("passes a genuine forward move through untouched", () => {
    const fresh = { headSha: NEW, baseSha: BASE_NEW, updatedAt: T2 };
    expect(preserveHeadOnStaleRead({ headSha: OLD, baseSha: BASE_OLD, updatedAt: T1 }, fresh)).toBe(
      fresh,
    );
  });

  it("passes everything through when there is no stored row yet", () => {
    const fresh = { headSha: OLD, baseSha: BASE_OLD, updatedAt: T1 };
    expect(preserveHeadOnStaleRead(undefined, fresh)).toBe(fresh);
  });

  it("passes through when nothing moved, whatever the timestamps say", () => {
    const fresh = { headSha: NEW, baseSha: BASE_NEW, updatedAt: T1 };
    expect(preserveHeadOnStaleRead(stored, fresh)).toBe(fresh);
  });

  // A base-only change with an unmoved head is a legitimate base-branch
  // advance, not a stale read — the head gives us nothing to disprove it with.
  it("lets a base-only change through when the head did not move", () => {
    const fresh = { headSha: NEW, baseSha: BASE_OLD, updatedAt: T1 };
    expect(preserveHeadOnStaleRead(stored, fresh)).toBe(fresh);
  });

  // The asymmetry that matters: masking is about losing information, not about
  // whether a supersede should fire. A first-ever head is not a regression.
  it("accepts a first head even when the payload looks older", () => {
    const fresh = { headSha: NEW, baseSha: BASE_NEW, updatedAt: T1 };
    expect(preserveHeadOnStaleRead({ headSha: null, baseSha: null, updatedAt: T2 }, fresh)).toBe(
      fresh,
    );
  });
});
