import type { AcpAgentId } from "@revv/shared";
import { logError } from "../../logger";

// ── Generic event-job registry ────────────────────────────────────────────────
//
// Shared backbone for the onboarding install (`Onboarding.ts`) and interactive
// login (`AgentLogin.ts`) services. Both run one process-lifetime-idempotent job
// per `AcpAgentId`, accumulate the job's events in an ephemeral replay buffer,
// and fan them out to SSE subscribers — committing each event to the buffer
// before broadcasting so a late subscriber replays the full transcript and still
// reacts to the terminal `{ type: 'done' }` event correctly.
//
// State is intentionally ephemeral. A `kill -9` mid-job just means the user
// re-runs it from the onboarding picker; nothing here needs to survive a crash.
//
// Per-feature extras (the login PTY handle, its auth-url scan buffer) ride on the
// job's `meta` slot so neither service has to re-implement the pub/sub plumbing.

/** Any event a job can broadcast; `{ type: 'done' }` closes the job. */
type JobEvent = { type: string };

export interface Job<E extends JobEvent, M> {
  jobId: string;
  agentId: AcpAgentId;
  /** Replay buffer — every broadcast event, in order. */
  events: E[];
  done: boolean;
  subscribers: Set<(event: E) => void>;
  /** Per-feature mutable state (e.g. the login PTY handle). */
  meta: M;
}

/** Subscription handle returned by {@link EventJobRegistry.subscribe}. */
export interface JobSubscription {
  /** True when the job id matched and the subscriber is registered. */
  found: boolean;
  /** Drop the listener. Safe to call multiple times. */
  unsubscribe: () => void;
}

export class EventJobRegistry<E extends JobEvent, M> {
  // Per-agent job state: read and written only from the owning service's
  // handlers, so a plain Map (not a Ref) is sufficient — ref-style
  // serialization buys nothing here.
  private readonly jobs = new Map<AcpAgentId, Job<E, M>>();

  constructor(private readonly logTag: string) {}

  /**
   * Commit `event` to the job's replay buffer, then fan it out to a snapshot of
   * the current subscribers (listeners may unsubscribe themselves synchronously
   * when they see `done`, mutating the live set). A terminal `{ type: 'done' }`
   * marks the job done and clears its subscribers.
   */
  broadcast(job: Job<E, M>, event: E): void {
    job.events.push(event);
    const snapshot = Array.from(job.subscribers);
    for (const sub of snapshot) {
      try {
        sub(event);
      } catch (err) {
        logError(
          this.logTag,
          "subscriber threw:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (event.type === "done") {
      job.done = true;
      job.subscribers.clear();
    }
  }

  /**
   * Start-or-join. Returns the in-flight job's id when one is already running for
   * `agentId`; otherwise creates a fresh job (its `meta` seeded by `makeMeta`),
   * registers it, and invokes `spawn` to drive it. `spawn` receives the job plus
   * a `broadcast` bound to it. Idempotent per agent — racing callers ride the
   * first job.
   */
  start(
    agentId: AcpAgentId,
    makeMeta: () => M,
    spawn: (job: Job<E, M>, broadcast: (event: E) => void) => void,
  ): { jobId: string } {
    const running = this.jobs.get(agentId);
    if (running && !running.done) {
      return { jobId: running.jobId };
    }
    const job: Job<E, M> = {
      jobId: crypto.randomUUID(),
      agentId,
      events: [],
      done: false,
      subscribers: new Set(),
      meta: makeMeta(),
    };
    this.jobs.set(agentId, job);
    spawn(job, (event) => this.broadcast(job, event));
    return { jobId: job.jobId };
  }

  /** Resolve a job by its id across all per-agent slots. */
  findById(jobId: string): Job<E, M> | undefined {
    for (const job of this.jobs.values()) {
      if (job.jobId === jobId) return job;
    }
    return undefined;
  }

  /**
   * Forget a job so a subsequent `start` for the same agent spawns fresh.
   * Used to retire a cancelled job whose underlying resource (e.g. a login PTY)
   * has been torn down.
   */
  delete(jobId: string): void {
    for (const [agentId, job] of this.jobs.entries()) {
      if (job.jobId === jobId) {
        this.jobs.delete(agentId);
        return;
      }
    }
  }

  /**
   * Register a callback that receives every event for the job: first the full
   * replay buffer (drained synchronously, before this returns, so no broadcast
   * interleaves between the snapshot and registration), then live events. If the
   * job is already terminal the listener fires through the replay and is never
   * registered for live events.
   */
  subscribe(jobId: string, onEvent: (event: E) => void): JobSubscription {
    const job = this.findById(jobId);
    if (!job) {
      return { found: false, unsubscribe: () => {} };
    }
    for (const event of job.events) onEvent(event);
    if (job.done) {
      return { found: true, unsubscribe: () => {} };
    }
    job.subscribers.add(onEvent);
    return {
      found: true,
      unsubscribe: () => {
        job.subscribers.delete(onEvent);
      },
    };
  }
}
