import { createHash } from "node:crypto";
import { isOpenLayer } from "@revv/shared";

/** The stack version a brief describes: its open layers, each at its head. */
export function stackSignature(
  layers: ReadonlyArray<{
    readonly number: number;
    readonly headSha: string | null;
    readonly status: string;
  }>,
): string {
  const version = layers
    .filter(isOpenLayer)
    .map((l) => `${l.number}@${l.headSha ?? "?"}`)
    .join(",");
  return createHash("sha256").update(version).digest("hex").slice(0, 32);
}
