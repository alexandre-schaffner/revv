import { describe, expect, test } from "bun:test";
import { takeawayOf } from "./review-reads";

describe("takeawayOf", () => {
  test("takes the first non-empty line, unformatted", () => {
    expect(takeawayOf("\n**Adds retries** to the poller.\n\n**Context** …")).toBe(
      "Adds retries to the poller.",
    );
  });
});
