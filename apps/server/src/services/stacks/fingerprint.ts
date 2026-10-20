// ── Layer fingerprints ──────────────────────────────────────────────────────
//
// A stacked PR's file list is three-dot against the layer below, so it holds
// exactly the layer's own changes. Hashing each file's status + patch (hunk
// headers included) gives a fingerprint that survives a rebase onto a moved
// layer only when the layer's changes, line numbers and all, are identical —
// the one case where a review can be carried over without anchors drifting.

import { createHash } from "node:crypto";
import { isOpenLayer } from "@revv/shared";

export type DiffFingerprint = Readonly<Record<string, string>>;

interface FingerprintFile {
  readonly filename: string;
  readonly status: string;
  readonly patch: string | null;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function fingerprintFiles(files: readonly FingerprintFile[]): DiffFingerprint {
  const out: Record<string, string> = {};
  for (const file of files) {
    // GitHub sends no patch for binaries and very large files: those can't be
    // compared, so they hash to a value no other fingerprint shares.
    out[file.filename] =
      file.patch === null ? `blob:${file.status}` : hash(`${file.status}\0${file.patch}`);
  }
  return out;
}

/** True when nothing in the fingerprint is a file GitHub sent without a patch. */
export function isComparable(fingerprint: DiffFingerprint): boolean {
  return Object.values(fingerprint).every((h) => !h.startsWith("blob:"));
}

/** Files whose changes differ between two fingerprints, sorted. */
export function changedFiles(before: DiffFingerprint, after: DiffFingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => {
      const a = before[name];
      const b = after[name];
      return a === undefined || b === undefined || a !== b || a.startsWith("blob:");
    })
    .sort();
}

export function parseFingerprint(json: string | null): DiffFingerprint | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** A stack version: the open layers, in order, at their heads. */
export function stackSignature(
  layers: ReadonlyArray<{
    readonly number: number;
    readonly headSha: string | null;
    readonly status: string;
  }>,
): string {
  return hash(
    layers
      .filter(isOpenLayer)
      .map((l) => `${l.number}@${l.headSha ?? "?"}`)
      .join(","),
  );
}
