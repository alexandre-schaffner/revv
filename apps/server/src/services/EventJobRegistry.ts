import type { AcpAgentId } from "@revv/shared";
import { logError } from "../logger";

// Shared backbone for the onboarding install (`Onboarding.ts`) and interactive
// login (`AgentLogin.ts`) services. Both run one process-lifetime-idempotent job
// per `AcpAgentId`, accumulate the job's events in an ephemeral replay buffer,
// and fan them out to SSE subscribers — committing each event to the buffer
// before broadcasting so a late subscriber replays the full transcript and still
// reacts to the terminal `{ type: 'done' }` event correctly.
//
// State is intentionally ephemeral. A `kill -9` mid-job just means the user
// re-runs it from the onboarding picker; nothing here needs to survive a crash.

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

export interface JobSubscription {
  /** True when the job id matched and the subscriber is registered. */
  found: boolean;
  /** Drop the listener. Safe to call multiple times. */
  unsubscribe: () => void;
}

export class EventJobRegistry<E extends JobEvent, M> {
  private readonly jobs = new Map<AcpAgentId, Job<E, M>>();

  constructor(private readonly logTag: string) {}

  /**
   * Fans out to a snapshot of the subscribers: a listener may unsubscribe
   * itself synchronously when it sees `done`.
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

  /** Start-or-join: while `agentId` has a job running, callers get its id and nothing spawns. */
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
