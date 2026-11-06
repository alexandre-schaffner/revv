import { Layer } from "effect";
import { AgentLoginServiceLive } from "./AgentLogin";
import { AiServiceLive } from "./Ai";
import { BroadcasterLive } from "./Broadcaster";
import { BaseConflictsServiceLive } from "./base-conflicts/BaseConflicts";
import { GcsBlobStoreLive } from "./blob/GcsBlobStore";
import { CacheServiceLive } from "./Cache";
import { ChatChangesPushServiceLive } from "./ChatChangesPush";
import { ChatMcpTokensLive } from "./ChatMcpTokens";
import { ChatSessionServiceLive } from "./ChatSession";
import { CacheEligibilityLive } from "./cache-eligibility";
import { SshSignerLive } from "./cache-signing/index";
import { DbServiceLive } from "./Db";
import { DbMaintenanceLive } from "./DbMaintenance";
import { DiffCacheServiceLive } from "./DiffCache";
import { ExternalIntegrationsLive } from "./ExternalIntegrations";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import { GitHubAccountsLive } from "./github/accounts";
import { AvatarCacheLive } from "./github/avatars";
import { GitHubGatewayLive } from "./github/gateway";
import { HunkScanServiceLive } from "./HunkScan";
import { JevServiceLive } from "./Jev";
import { OnboardingServiceLive } from "./Onboarding";
import { PollSchedulerLive } from "./PollScheduler";
import { PrContextServiceLive } from "./PrContext";
import { PrConversationServiceLive } from "./PrConversation";
import { PrMirrorLive } from "./PrMirror";
import { ProjectRecapServiceLive } from "./ProjectRecap";
import { ProjectRecapJobsLive } from "./ProjectRecapJobs";
import { PrPushLockServiceLive } from "./PrPushLock";
import { PullRequestServiceLive } from "./PullRequest";
import { RealtimeLive } from "./Realtime";
import { RecapSchedulerLive } from "./RecapScheduler";
import { RemoteWalkthroughCacheLive } from "./RemoteWalkthroughCache";
import { RepoCloneServiceLive } from "./RepoClone";
import { RepositoryServiceLive } from "./Repository";
import { ReviewServiceLive } from "./Review";
import { SecretStoreLive } from "./SecretStore";
import { SettingsServiceLive } from "./Settings";
import { SyncServiceLive } from "./Sync";
import { StackBriefJobsLive } from "./stacks/StackBriefJobs";
import { StackHeadlineServiceLive } from "./stacks/StackHeadlines";
import { StackMergeServiceLive } from "./stacks/StackMerge";
import { StackRebaseServiceLive } from "./stacks/StackRebase";
import { StackReviewServiceLive } from "./stacks/StackReview";
import { StackServiceLive } from "./stacks/StackService";
import { WalkthroughServiceLive } from "./Walkthrough";
import { WalkthroughJobsLive } from "./WalkthroughJobs";
import { WalkthroughSnapshotImporterLive } from "./WalkthroughSnapshotImporter";

const RealtimeWithDeps = RealtimeLive.pipe(
  Layer.provide(Layer.mergeAll(BroadcasterLive, DbServiceLive)),
);

const ReviewServiceWithDeps = ReviewServiceLive.pipe(Layer.provide(RealtimeWithDeps));

// SettingsService now reads/writes via DbService instead of JSON file
const SettingsServiceWithDeps = SettingsServiceLive.pipe(Layer.provide(DbServiceLive));

const GitHubAccountsWithDeps = GitHubAccountsLive.pipe(
  Layer.provide(
    Layer.mergeAll(DbServiceLive, SecretStoreLive, RealtimeWithDeps, SettingsServiceWithDeps),
  ),
);

const GitHubEtagCacheWithDeps = GitHubEtagCacheLive.pipe(Layer.provide(DbServiceLive));

// The gateway reports every account's 401s and rate limits to GitHubAccounts.
const GitHubGatewayWithDeps = GitHubGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(GitHubEtagCacheWithDeps, GitHubAccountsWithDeps)),
);

// ChatSessionService is a thin Drizzle wrapper for the right-pane chat —
// uses Layer.effect to grab `db` at construction, so we satisfy DbService
// at the same boundary other DB-dependent services do.
const ChatSessionServiceWithDeps = ChatSessionServiceLive.pipe(Layer.provide(DbServiceLive));

const ExternalIntegrationsWithDeps = ExternalIntegrationsLive.pipe(Layer.provide(DbServiceLive));

const AvatarCacheWithDeps = AvatarCacheLive.pipe(Layer.provide(DbServiceLive));

const DiffCacheServiceWithDeps = DiffCacheServiceLive.pipe(
  Layer.provide(Layer.mergeAll(DbServiceLive, GitHubGatewayWithDeps, RealtimeWithDeps)),
);

// JevService depends on SettingsService (toggles) and SecretStore (API key); both are leaves.
const JevServiceWithDeps = JevServiceLive.pipe(
  Layer.provide(Layer.mergeAll(SettingsServiceWithDeps, SecretStoreLive)),
);

// Base layer: all services that have no deps or only depend on DbService
const BaseLayers = Layer.mergeAll(
  DbServiceLive,
  SecretStoreLive,
  GitHubAccountsWithDeps,
  GitHubEtagCacheWithDeps,
  GitHubGatewayWithDeps,
  BroadcasterLive,
  RealtimeWithDeps,
  RepositoryServiceLive,
  PullRequestServiceLive,
  ReviewServiceWithDeps,
  AvatarCacheWithDeps,
  SettingsServiceWithDeps,
  JevServiceWithDeps,
  WalkthroughServiceLive,
  ProjectRecapServiceLive,
  DiffCacheServiceWithDeps,
  CacheServiceLive,
  OnboardingServiceLive,
  AgentLoginServiceLive,
  ChatSessionServiceWithDeps,
  ChatMcpTokensLive,
  PrPushLockServiceLive,
  ExternalIntegrationsWithDeps,
);

// PrContext composes PR + Repo + Token + GitHub + DiffCache — built from BaseLayers
const PrContextServiceWithDeps = PrContextServiceLive.pipe(Layer.provide(BaseLayers));

// PrConversation serves the Conversation tab: PrContext for repo + token,
// plus the kv cache, remote-user avatars, and Realtime from BaseLayers.
const PrConversationServiceWithDeps = PrConversationServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

const StackServiceWithDeps = StackServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

const StackHeadlineServiceWithDeps = StackHeadlineServiceLive.pipe(Layer.provide(BaseLayers));

// SyncService depends on BaseLayers + PrContext (for resolving repo/token chains)
const SyncServiceWithDeps = SyncServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

// AiService depends on DbService + SettingsService (both in BaseLayers)
const AiServiceWithDeps = AiServiceLive.pipe(Layer.provide(BaseLayers));

// RepoCloneService depends on DbService + Realtime (both in BaseLayers)
const RepoCloneServiceWithDeps = RepoCloneServiceLive.pipe(Layer.provide(BaseLayers));

// DbMaintenance only needs DbService (already in BaseLayers)
const DbMaintenanceWithDeps = DbMaintenanceLive.pipe(Layer.provide(DbServiceLive));

// Team remote walkthrough cache — opt-in GCS-backed snapshot store.
// GcsBlobStore depends on SettingsService (to read bucket + credentials);
// RemoteWalkthroughCache stacks on top of BlobStore + Settings + Db +
// SshSigner + CacheEligibility. The importer is a thin Drizzle wrapper.
const GcsBlobStoreWithDeps = GcsBlobStoreLive.pipe(Layer.provide(SettingsServiceWithDeps));
const SshSignerWithDeps = SshSignerLive.pipe(
  Layer.provide(Layer.mergeAll(SettingsServiceWithDeps, GitHubAccountsWithDeps)),
);
const CacheEligibilityWithDeps = CacheEligibilityLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers)),
);
const RemoteWalkthroughCacheWithDeps = RemoteWalkthroughCacheLive.pipe(
  Layer.provide(
    Layer.mergeAll(BaseLayers, GcsBlobStoreWithDeps, SshSignerWithDeps, CacheEligibilityWithDeps),
  ),
);
const WalkthroughSnapshotImporterWithDeps = WalkthroughSnapshotImporterLive;

// The first pass, per PR head. One instance: the review page and
// WalkthroughJobs must share its in-flight map so a head is scanned once.
const HunkScanServiceWithDeps = HunkScanServiceLive.pipe(Layer.provide(BaseLayers));

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
      HunkScanServiceWithDeps,
      StackServiceWithDeps,
    ),
  ),
);

// The one writer of GitHub's view of a PR: supersedes walkthroughs on a head
// move, reaps worktrees and marks stacks stale on a close.
const PrMirrorWithDeps = PrMirrorLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      WalkthroughJobsWithDeps,
      RepoCloneServiceWithDeps,
      StackServiceWithDeps,
    ),
  ),
);

const PollSchedulerWithDeps = PollSchedulerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      SyncServiceWithDeps,
      WalkthroughJobsWithDeps,
      PrMirrorWithDeps,
    ),
  ),
);

// ProjectRecapJobs is the recap orchestrator. Mirrors WalkthroughJobs but
// simpler — no worktree / continuation. Depends on BaseLayers for repo,
// PR, recap service, settings, and Realtime.
const ProjectRecapJobsWithDeps = ProjectRecapJobsLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, PrMirrorWithDeps)),
);

// RecapScheduler depends on ProjectRecapJobs (to enqueue) plus BaseLayers
// for repo/PR/recap reads.
const RecapSchedulerWithDeps = RecapSchedulerLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, ProjectRecapJobsWithDeps)),
);

const StackBriefJobsWithDeps = StackBriefJobsLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, StackServiceWithDeps)),
);
const StackReviewServiceWithDeps = StackReviewServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      StackServiceWithDeps,
      WalkthroughJobsWithDeps,
      StackBriefJobsWithDeps,
    ),
  ),
);

const StackRebaseServiceWithDeps = StackRebaseServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, StackServiceWithDeps)),
);

const StackMergeServiceWithDeps = StackMergeServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      StackServiceWithDeps,
      StackRebaseServiceWithDeps,
    ),
  ),
);

// ChatChangesPush depends on PrContext (for resolving repo+token), AiService
// (for invoking the conflict-resolution agent), and BaseLayers (db, github,
// chat sessions, realtime broadcaster, pr service, etag cache).
const ChatChangesPushServiceWithDeps = ChatChangesPushServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, AiServiceWithDeps, PrMirrorWithDeps),
  ),
);

// BaseConflicts shares the per-PR push lock with ChatChangesPush through
// BaseLayers, and runs the same one-shot conflict-resolve agent.
const BaseConflictsServiceWithDeps = BaseConflictsServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, AiServiceWithDeps, PrMirrorWithDeps),
  ),
);

// AppLayer merges everything together so consumers get all services
export const AppLayer = Layer.mergeAll(
  BaseLayers,
  PrContextServiceWithDeps,
  PrConversationServiceWithDeps,
  StackServiceWithDeps,
  StackHeadlineServiceWithDeps,
  SyncServiceWithDeps,
  PollSchedulerWithDeps,
  PrMirrorWithDeps,
  AiServiceWithDeps,
  RepoCloneServiceWithDeps,
  WalkthroughJobsWithDeps,
  HunkScanServiceWithDeps,
  ProjectRecapJobsWithDeps,
  RecapSchedulerWithDeps,
  StackBriefJobsWithDeps,
  StackReviewServiceWithDeps,
  StackMergeServiceWithDeps,
  StackRebaseServiceWithDeps,
  DbMaintenanceWithDeps,
  ChatChangesPushServiceWithDeps,
  BaseConflictsServiceWithDeps,
  // Surface the remote-cache + blob + signing primitives in the runtime so
  // HTTP routes (e.g. GET /api/settings/cache/status, POST /api/settings/cache/signing/test)
  // can resolve them directly.
  GcsBlobStoreWithDeps,
  RemoteWalkthroughCacheWithDeps,
  WalkthroughSnapshotImporterWithDeps,
  SshSignerWithDeps,
  CacheEligibilityWithDeps,
);
