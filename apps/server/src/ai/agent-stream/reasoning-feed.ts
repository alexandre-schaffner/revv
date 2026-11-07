// How a job's live feed shows the agent reasoning: every non-empty reasoning
// delta as a thought, and a heartbeat at most every 30 s while it continues,
// so a long thinking gap still reads as a live run without repeating on every
// token.

const REASONING_HEARTBEAT_MS = 30_000;

export function makeReasoningFeed(
  on: { readonly thought: (text: string) => void; readonly heartbeat: () => void },
  now: () => number = Date.now,
): (delta: string) => void {
  let lastHeartbeatAt = 0;
  return (delta) => {
    if (delta.length > 0) on.thought(delta);
    const t = now();
    if (t - lastHeartbeatAt >= REASONING_HEARTBEAT_MS) {
      lastHeartbeatAt = t;
      on.heartbeat();
    }
  };
}
