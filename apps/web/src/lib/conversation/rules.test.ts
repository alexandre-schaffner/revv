import { describe, expect, it } from "bun:test";
import {
  type CiCheck,
  type CiRollup,
  ciHasPending,
  ciStanding,
  hasMergeConflicts,
  isMergeableState,
  isMergeStateSettling,
  type ReviewerEntry,
  reviewerVerdict,
  rollupBucket,
} from "@revv/shared";

function rollup(state: CiRollup["state"], buckets: CiCheck["bucket"][] = []): CiRollup {
  return {
    headSha: "h",
    state,
    checks: buckets.map((bucket, i) => ({ key: `c${i}`, bucket }) as CiCheck),
  };
}

describe("CI rollup", () => {
  it("reads expected as pending and error as a failure", () => {
    expect(rollupBucket("expected")).toBe("pending");
    expect(rollupBucket("error")).toBe("fail");
    expect(rollupBucket(null)).toBeNull();
  });

  it("lets a failing check outweigh a pending rollup", () => {
    expect(ciStanding(rollup("pending", ["fail"]))).toBe("fail");
    expect(ciStanding(rollup("success", ["pending", "pass"]))).toBe("pending");
    expect(ciStanding(rollup("success", ["pass"]))).toBe("pass");
    expect(ciStanding(null)).toBeNull();
  });

  it("is still pending while any single check runs, even beside a failure", () => {
    expect(ciHasPending(rollup("failure", ["fail", "pending"]))).toBe(true);
    expect(ciHasPending(rollup("expected"))).toBe(true);
    expect(ciHasPending(rollup("failure", ["fail"]))).toBe(false);
  });
});

describe("mergeStateStatus", () => {
  it("ignores case and reads an absent answer as still settling", () => {
    expect(hasMergeConflicts("dirty")).toBe(true);
    expect(isMergeableState("has_hooks")).toBe(true);
    expect(isMergeStateSettling(null)).toBe(true);
    expect(isMergeableState("BLOCKED")).toBe(false);
  });
});

describe("reviewerVerdict", () => {
  const user = (verdict: Extract<ReviewerEntry, { kind: "user" }>["verdict"], requested: boolean) =>
    ({
      kind: "user",
      actor: { login: "alice", avatarContent: null },
      requested,
      asCodeOwner: false,
      verdict,
      verdictAt: null,
    }) as ReviewerEntry;

  it("awaits a re-requested reviewer who only commented", () => {
    expect(reviewerVerdict(user("commented", true))).toBeNull();
    expect(reviewerVerdict(user("commented", false))).toBe("commented");
  });

  it("keeps an approval or change request through a re-request", () => {
    expect(reviewerVerdict(user("approved", true))).toBe("approved");
    expect(reviewerVerdict(user("changes_requested", true))).toBe("changes_requested");
  });
});
