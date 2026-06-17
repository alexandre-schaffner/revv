import { Effect } from "effect";
import type { OpencodeClient, OpencodeEndpoint } from "../../services/OpencodeSupervisor";
import type { OpencodeProviderDeps } from "./mcp-walkthrough-opencode";
import type { RecapOpencodeSessionDeps, RecapOpencodeSupervisorDeps } from "./recap-opencode";
import type { RecapToolContext } from "./recap-tools";

interface OpencodeSupervisorRuntime {
  readonly ensureRunning: () => Effect.Effect<OpencodeEndpoint, unknown>;
  readonly jobStarted: () => Effect.Effect<void, unknown>;
  readonly jobEnded: () => Effect.Effect<void, unknown>;
  readonly client: () => Effect.Effect<OpencodeClient | null, unknown>;
}

interface WalkthroughOpencodeCallbacks {
  readonly issueSessionToken: (walkthroughId: string) => Promise<string>;
  readonly clearSessionToken: (token: string) => Promise<void>;
  readonly registerActivityNotifier: OpencodeProviderDeps["registerActivityNotifier"];
  readonly unregisterActivityNotifier: (walkthroughId: string) => Promise<void>;
}

interface RecapSessionCallbacks {
  readonly issueSessionToken: (ctx: RecapToolContext) => Promise<string>;
  readonly clearSessionToken: (token: string) => Promise<void>;
}

export interface OpencodeRecapDeps {
  readonly supervisorDeps: RecapOpencodeSupervisorDeps;
  readonly sessionDeps: RecapOpencodeSessionDeps;
}

function makeOpencodeSupervisorDeps(
  supervisor: OpencodeSupervisorRuntime,
): RecapOpencodeSupervisorDeps {
  return {
    ensureDaemon: () => Effect.runPromise(supervisor.ensureRunning()),
    jobStarted: () => Effect.runPromise(supervisor.jobStarted()),
    jobEnded: () => Effect.runPromise(supervisor.jobEnded()),
    client: () => Effect.runPromise(supervisor.client()),
  };
}

export function makeOpencodeWalkthroughDeps(
  supervisor: OpencodeSupervisorRuntime,
  callbacks: WalkthroughOpencodeCallbacks,
): OpencodeProviderDeps {
  return {
    ...makeOpencodeSupervisorDeps(supervisor),
    issueSessionToken: callbacks.issueSessionToken,
    clearSessionToken: callbacks.clearSessionToken,
    registerActivityNotifier: callbacks.registerActivityNotifier,
    unregisterActivityNotifier: callbacks.unregisterActivityNotifier,
  };
}

export function makeOpencodeRecapDeps(
  supervisor: OpencodeSupervisorRuntime,
  callbacks: RecapSessionCallbacks,
): OpencodeRecapDeps {
  return {
    supervisorDeps: makeOpencodeSupervisorDeps(supervisor),
    sessionDeps: {
      issueSessionToken: callbacks.issueSessionToken,
      clearSessionToken: callbacks.clearSessionToken,
    },
  };
}
