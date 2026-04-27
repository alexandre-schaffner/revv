import { Layer } from "effect";
import { CacheStatsLive, InvalidationBusLive } from "../cache/index";
import { AiServiceLive } from "./Ai";
import { CacheServiceLive } from "./Cache";
import { DbServiceLive } from "./Db";
import { DbMaintenanceLive } from "./DbMaintenance";
import { DiffCacheServiceLive } from "./DiffCache";
import { FileContentServiceLive } from "./FileContent";
import { GitHubServiceLive } from "./GitHub";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import { OpencodeSupervisorLive } from "./OpencodeSupervisor";
import { PollSchedulerLive } from "./PollScheduler";
import { PrContextServiceLive } from "./PrContext";
import { PullRequestServiceLive } from "./PullRequest";
import { RepoCloneServiceLive } from "./RepoClone";
import { RepositoryServiceLive } from "./Repository";
import { ReviewServiceLive } from "./Review";
import { SettingsServiceLive } from "./Settings";
import { SyncServiceLive } from "./Sync";
import { TokenProviderLive } from "./TokenProvider";
import { WalkthroughServiceLive } from "./Walkthrough";
import { WalkthroughJobsLive } from "./WalkthroughJobs";
import { WebSocketHubLive } from "./WebSocketHub";
import { WorkspaceServiceLive } from "./Workspace";

// TokenProvider now needs DbService
const TokenProviderWithDeps = TokenProviderLive.pipe(
  Layer.provide(DbServiceLive),
);

// GitHub service now depends on the etag cache for conditional requests.
const GitHubServiceWithDeps = GitHubServiceLive.pipe(
  Layer.provide(GitHubEtagCacheLive),
);

// OpencodeSupervisor depends on DbService + SettingsService (for detecting
// agent-changed + resolving the selected agent). It's in BaseLayers because
// AiService needs it; AiService in turn is consumed by WalkthroughJobs.
const OpencodeSupervisorWithDeps = OpencodeSupervisorLive.pipe(
  Layer.provide(Layer.mergeAll(DbServiceLive, SettingsServiceLive)),
);

// Base layer: all services that have no deps or only depend on DbService
const BaseLayers = Layer.mergeAll(
  DbServiceLive,
  TokenProviderWithDeps,
  GitHubEtagCacheLive,
  GitHubServiceWithDeps,
  WebSocketHubLive,
  RepositoryServiceLive,
  PullRequestServiceLive,
  ReviewServiceLive,
  SettingsServiceLive,
  WalkthroughServiceLive,
  DiffCacheServiceLive,
  FileContentServiceLive,
  CacheServiceLive,
  OpencodeSupervisorWithDeps,
  // Unified cache layer (M1 Foundations) — InvalidationBus is live with zero
  // publishers yet; CacheStats is ready for per-namespace registrations as
  // existing services migrate to adapters in M2.
  CacheStatsLive,
  InvalidationBusLive,
  WorkspaceServiceLive,
);

// PrContext composes PR + Repo + Token + GitHub + DiffCache — built from BaseLayers
const PrContextServiceWithDeps = PrContextServiceLive.pipe(
  Layer.provide(BaseLayers),
);

// SyncService depends on BaseLayers + PrContext (for resolving repo/token chains)
const SyncServiceWithDeps = SyncServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

// AiService depends on DbService + SettingsService (both in BaseLayers)
const AiServiceWithDeps = AiServiceLive.pipe(Layer.provide(BaseLayers));

// RepoCloneService depends on DbService + WebSocketHub (both in BaseLayers)
const RepoCloneServiceWithDeps = RepoCloneServiceLive.pipe(
  Layer.provide(BaseLayers),
);

// DbMaintenance only needs DbService (already in BaseLayers)
const DbMaintenanceWithDeps = DbMaintenanceLive.pipe(
  Layer.provide(DbServiceLive),
);

// WalkthroughJobs is the central orchestrator for walkthrough generation —
// it depends on PrContext (to resolve PR metadata), RepoClone (for scoped
// worktrees), Ai (to run the actual generator), Review (for session ids),
// plus everything in BaseLayers. Splitting this out as its own layer lets
// consumers (SSE handler, regenerate handler, index.ts startup) tag it
// directly without needing to know the full dependency graph.
const WalkthroughJobsWithDeps = WalkthroughJobsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      AiServiceWithDeps,
      RepoCloneServiceWithDeps,
    ),
  ),
);

// PollScheduler depends on BaseLayers + SyncService (for thread polling) +
// WalkthroughJobs (for superseding walkthroughs when a new head SHA arrives).
const PollSchedulerWithDeps = PollSchedulerLive.pipe(
  Layer.provide(
    Layer.mergeAll(BaseLayers, SyncServiceWithDeps, WalkthroughJobsWithDeps),
  ),
);

// AppLayer merges everything together so consumers get all services
export const AppLayer = Layer.mergeAll(
  BaseLayers,
  PrContextServiceWithDeps,
  SyncServiceWithDeps,
  PollSchedulerWithDeps,
  AiServiceWithDeps,
  RepoCloneServiceWithDeps,
  WalkthroughJobsWithDeps,
  DbMaintenanceWithDeps,
);
