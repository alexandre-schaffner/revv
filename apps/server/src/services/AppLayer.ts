import { Layer } from "effect";
import { CacheStatsLive, InvalidationBusLive } from "../cache/index";
import { AiServiceLive } from "./Ai";
import { GcsBlobStoreLive } from "./blob/GcsBlobStore";
import { CacheServiceLive } from "./Cache";
import { ChatChangesPushServiceLive } from "./ChatChangesPush";
import { ChatMcpTokensLive } from "./ChatMcpTokens";
import { ChatSessionServiceLive } from "./ChatSession";
import { DbServiceLive } from "./Db";
import { DbMaintenanceLive } from "./DbMaintenance";
import { DiffCacheServiceLive } from "./DiffCache";
import { EventBusLive } from "./EventBus";
import { FileContentServiceLive } from "./FileContent";
import { GitHubServiceLive } from "./GitHub";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import { OnboardingServiceLive } from "./Onboarding";
import { OpencodeSupervisorLive } from "./OpencodeSupervisor";
import { PollSchedulerLive } from "./PollScheduler";
import { PrContextServiceLive } from "./PrContext";
import { ProjectRecapServiceLive } from "./ProjectRecap";
import { ProjectRecapJobsLive } from "./ProjectRecapJobs";
import { PullRequestServiceLive } from "./PullRequest";
import { RecapSchedulerLive } from "./RecapScheduler";
import { RemoteWalkthroughCacheLive } from "./RemoteWalkthroughCache";
import { RepoCloneServiceLive } from "./RepoClone";
import { RepositoryServiceLive } from "./Repository";
import { ReviewServiceLive } from "./Review";
import { SettingsServiceLive } from "./Settings";
import { SyncServiceLive } from "./Sync";
import { TokenProviderLive } from "./TokenProvider";
import { WalkthroughServiceLive } from "./Walkthrough";
import { WalkthroughJobsLive } from "./WalkthroughJobs";
import { WalkthroughSnapshotImporterLive } from "./WalkthroughSnapshotImporter";
import { WebSocketHubLive } from "./WebSocketHub";

// TokenProvider now needs DbService
const TokenProviderWithDeps = TokenProviderLive.pipe(Layer.provide(DbServiceLive));

// SettingsService now reads/writes via DbService instead of JSON file
const SettingsServiceWithDeps = SettingsServiceLive.pipe(Layer.provide(DbServiceLive));

// GitHub service depends on the etag cache for conditional requests,
// and on SettingsService to resolve the API base URL dynamically.
const GitHubServiceWithDeps = GitHubServiceLive.pipe(
  Layer.provide(Layer.mergeAll(GitHubEtagCacheLive, SettingsServiceWithDeps)),
);

// OpencodeSupervisor depends on DbService + SettingsService (for detecting
// agent-changed + resolving the selected agent). It's in BaseLayers because
// AiService needs it; AiService in turn is consumed by WalkthroughJobs.
const OpencodeSupervisorWithDeps = OpencodeSupervisorLive.pipe(
  Layer.provide(Layer.mergeAll(DbServiceLive, SettingsServiceWithDeps)),
);

// ChatSessionService is a thin Drizzle wrapper for the right-pane chat —
// uses Layer.effect to grab `db` at construction, so we satisfy DbService
// at the same boundary other DB-dependent services do.
const ChatSessionServiceWithDeps = ChatSessionServiceLive.pipe(Layer.provide(DbServiceLive));

// Base layer: all services that have no deps or only depend on DbService
const BaseLayers = Layer.mergeAll(
  DbServiceLive,
  TokenProviderWithDeps,
  GitHubEtagCacheLive,
  GitHubServiceWithDeps,
  WebSocketHubLive,
  EventBusLive,
  RepositoryServiceLive,
  PullRequestServiceLive,
  ReviewServiceLive,
  SettingsServiceWithDeps,
  WalkthroughServiceLive,
  ProjectRecapServiceLive,
  DiffCacheServiceLive,
  FileContentServiceLive,
  CacheServiceLive,
  OnboardingServiceLive,
  OpencodeSupervisorWithDeps,
  ChatSessionServiceWithDeps,
  ChatMcpTokensLive,
  // Unified cache layer (M1 Foundations) — InvalidationBus is live with zero
  // publishers yet; CacheStats is ready for per-namespace registrations as
  // existing services migrate to adapters in M2.
  CacheStatsLive,
  InvalidationBusLive,
);

// PrContext composes PR + Repo + Token + GitHub + DiffCache — built from BaseLayers
const PrContextServiceWithDeps = PrContextServiceLive.pipe(Layer.provide(BaseLayers));

// SyncService depends on BaseLayers + PrContext (for resolving repo/token chains)
const SyncServiceWithDeps = SyncServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

// AiService depends on DbService + SettingsService (both in BaseLayers)
const AiServiceWithDeps = AiServiceLive.pipe(Layer.provide(BaseLayers));

// RepoCloneService depends on DbService + WebSocketHub (both in BaseLayers)
const RepoCloneServiceWithDeps = RepoCloneServiceLive.pipe(Layer.provide(BaseLayers));

// DbMaintenance only needs DbService (already in BaseLayers)
const DbMaintenanceWithDeps = DbMaintenanceLive.pipe(Layer.provide(DbServiceLive));

// Team remote walkthrough cache — opt-in GCS-backed snapshot store.
// GcsBlobStore depends on SettingsService (to read bucket + credentials);
// RemoteWalkthroughCache stacks on top of BlobStore + Settings + Db. The
// importer is a thin Drizzle wrapper, no external deps beyond DbService.
const GcsBlobStoreWithDeps = GcsBlobStoreLive.pipe(Layer.provide(SettingsServiceWithDeps));
const RemoteWalkthroughCacheWithDeps = RemoteWalkthroughCacheLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, GcsBlobStoreWithDeps)),
);
const WalkthroughSnapshotImporterWithDeps = WalkthroughSnapshotImporterLive;

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
      RemoteWalkthroughCacheWithDeps,
      WalkthroughSnapshotImporterWithDeps,
    ),
  ),
);

// PollScheduler depends on BaseLayers + SyncService (for thread polling) +
// WalkthroughJobs (for superseding walkthroughs when a new head SHA arrives).
const PollSchedulerWithDeps = PollSchedulerLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, SyncServiceWithDeps, WalkthroughJobsWithDeps)),
);

// ProjectRecapJobs is the recap orchestrator. Mirrors WalkthroughJobs but
// simpler — no worktree / continuation. Depends on BaseLayers for repo,
// PR, recap service, settings, and WebSocketHub.
const ProjectRecapJobsWithDeps = ProjectRecapJobsLive.pipe(Layer.provide(BaseLayers));

// RecapScheduler depends on ProjectRecapJobs (to enqueue) plus BaseLayers
// for repo/PR/recap reads.
const RecapSchedulerWithDeps = RecapSchedulerLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, ProjectRecapJobsWithDeps)),
);

// ChatChangesPush depends on PrContext (for resolving repo+token), AiService
// (for invoking the conflict-resolution agent), and BaseLayers (db, github,
// chat sessions, ws hub, pr service, etag cache).
const ChatChangesPushServiceWithDeps = ChatChangesPushServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, AiServiceWithDeps)),
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
  ProjectRecapJobsWithDeps,
  RecapSchedulerWithDeps,
  DbMaintenanceWithDeps,
  ChatChangesPushServiceWithDeps,
  // Surface the remote-cache + blob primitives in the runtime so HTTP
  // routes (e.g. GET /api/settings/cache/status) can resolve them directly.
  GcsBlobStoreWithDeps,
  RemoteWalkthroughCacheWithDeps,
  WalkthroughSnapshotImporterWithDeps,
);
