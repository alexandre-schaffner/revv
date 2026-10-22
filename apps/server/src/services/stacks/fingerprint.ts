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

export function isComparable(fingerprint: DiffFingerprint): boolean {
  return Object.values(fingerprint).every((h) => !h.startsWith("blob:"));
}

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
