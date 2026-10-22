import { createHash } from "node:crypto";
import { parseOtlp } from "../../apps/collector/src/store/ingest";
import { commentableLines } from "../../apps/server/src/services/diff-anchors";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Fixtures are synthetic, deterministic, and independent of the application DB.
// Keep their identity stable while optimizing production code. Correctness is
// checked outside the timed section against the complete serialized result.
export function workload(name: string): { id: string; fixtureHash: string; run: () => unknown } {
  if (name === "otlp") {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "revv-benchmark" } }],
          },
          scopeSpans: [
            {
              spans: Array.from({ length: 500 }, (_, index) => ({
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: index.toString(16).padStart(16, "0"),
                name: "Mcp.add_diff_step",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000025000000",
                status: { code: 1 },
                attributes: [
                  { key: "walkthroughId", value: { stringValue: `review-${index % 10}` } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: 1200 } },
                ],
              })),
            },
          ],
        },
      ],
    };
    return {
      id: "otlp-500-v1",
      fixtureHash: hash(JSON.stringify(payload)),
      run: () => parseOtlp(payload),
    };
  }
  if (name === "diff-anchors") {
    const patch = Array.from(
      { length: 100 },
      (_, index) =>
        `@@ -${index * 30 + 1},20 +${index * 30 + 1},20 @@\n` +
        Array.from(
          { length: 10 },
          (_, line) => ` context ${line}\n-old ${line}\n+new ${line}`,
        ).join("\n"),
    ).join("\n");
    return {
      id: "diff-anchors-100-v1",
      fixtureHash: hash(patch),
      run: () => commentableLines(patch),
    };
  }
  throw new Error(`Unknown workload ${name}; choose otlp or diff-anchors`);
}
