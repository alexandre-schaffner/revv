import { Layer } from "effect";
import { AgentLoginServiceLive } from "./AgentLogin";
import { AiServiceLive } from "./Ai";
import { BroadcasterLive } from "./Broadcaster";
import { BaseConflictsServiceLive } from "./base-conflicts/BaseConflicts";
import { GcsBlobStoreLive } from "./blob/GcsBlobStore";
import { CacheServiceLive } from "./Cache";
import { CacheEligibilityLive } from "./cache-eligibility";
import { SshSignerLive } from "./cache-signing/index";
import { ChatMcpTokensLive } from "./chat/ChatMcpTokens";
import { ChatSessionServiceLive } from "./chat/ChatSession";
import { ChatTurnServiceLive } from "./chat/ChatTurn";
import { RepoCloneServiceLive } from "./clone/RepoClone";
import { DbServiceLive } from "./Db";
import { DbMaintenanceLive } from "./DbMaintenance";
import { DiffCacheServiceLive } from "./DiffCache";
import { ExternalIntegrationsLive } from "./ExternalIntegrations";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import { BranchPushLockLive } from "./git/branch-push-lock";
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
import { PullRequestServiceLive } from "./PullRequest";
import { RealtimeLive } from "./Realtime";
import { RecapSchedulerLive } from "./RecapScheduler";
import { RemoteWalkthroughCacheLive } from "./RemoteWalkthroughCache";
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
import { AgentWorktreesLive } from "./workspace/agent-worktrees";
import { PrWorkspaceLive } from "./workspace/PrWorkspace";

const RealtimeWithDeps = RealtimeLive.pipe(
  Layer.provide(Layer.mergeAll(BroadcasterLive, DbServiceLive)),
);

const ReviewServiceWithDeps = ReviewServiceLive.pipe(Layer.provide(RealtimeWithDeps));

const SettingsServiceWithDeps = SettingsServiceLive.pipe(Layer.provide(DbServiceLive));

const GitHubAccountsWithDeps = GitHubAccountsLive.pipe(
  Layer.provide(
    Layer.mergeAll(DbServiceLive, SecretStoreLive, RealtimeWithDeps, SettingsServiceWithDeps),
  ),
);

const GitHubEtagCacheWithDeps = GitHubEtagCacheLive.pipe(Layer.provide(DbServiceLive));

const GitHubGatewayWithDeps = GitHubGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(GitHubEtagCacheWithDeps, GitHubAccountsWithDeps)),
);

const ChatSessionServiceWithDeps = ChatSessionServiceLive.pipe(Layer.provide(DbServiceLive));

const ExternalIntegrationsWithDeps = ExternalIntegrationsLive.pipe(Layer.provide(DbServiceLive));

const AvatarCacheWithDeps = AvatarCacheLive.pipe(Layer.provide(DbServiceLive));

const DiffCacheServiceWithDeps = DiffCacheServiceLive.pipe(
  Layer.provide(Layer.mergeAll(DbServiceLive, GitHubGatewayWithDeps, RealtimeWithDeps)),
);

const JevServiceWithDeps = JevServiceLive.pipe(
  Layer.provide(Layer.mergeAll(SettingsServiceWithDeps, SecretStoreLive)),
);

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
  BranchPushLockLive,
  ExternalIntegrationsWithDeps,
);

const PrContextServiceWithDeps = PrContextServiceLive.pipe(Layer.provide(BaseLayers));

const PrConversationServiceWithDeps = PrConversationServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

const StackServiceWithDeps = StackServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

const StackHeadlineServiceWithDeps = StackHeadlineServiceLive.pipe(Layer.provide(BaseLayers));

const SyncServiceWithDeps = SyncServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps)),
);

const AiServiceWithDeps = AiServiceLive.pipe(Layer.provide(BaseLayers));

const RepoCloneServiceWithDeps = RepoCloneServiceLive.pipe(Layer.provide(BaseLayers));

const AgentWorktreesWithDeps = AgentWorktreesLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, RepoCloneServiceWithDeps)),
);

const DbMaintenanceWithDeps = DbMaintenanceLive.pipe(Layer.provide(DbServiceLive));

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

// One instance: the review page and WalkthroughJobs must share its in-flight
// map so a head is scanned once.
const HunkScanServiceWithDeps = HunkScanServiceLive.pipe(Layer.provide(BaseLayers));

const WalkthroughJobsWithDeps = WalkthroughJobsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      AiServiceWithDeps,
      RepoCloneServiceWithDeps,
      RemoteWalkthroughCacheWithDeps,
      WalkthroughSnapshotImporterLive,
      HunkScanServiceWithDeps,
      StackServiceWithDeps,
    ),
  ),
);

const PrMirrorWithDeps = PrMirrorLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      WalkthroughJobsWithDeps,
      AgentWorktreesWithDeps,
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

const ProjectRecapJobsWithDeps = ProjectRecapJobsLive.pipe(
  Layer.provide(Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, PrMirrorWithDeps)),
);

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
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      StackServiceWithDeps,
      RepoCloneServiceWithDeps,
      PrMirrorWithDeps,
    ),
  ),
);

const StackMergeServiceWithDeps = StackMergeServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      StackServiceWithDeps,
      StackRebaseServiceWithDeps,
      PrMirrorWithDeps,
    ),
  ),
);

const PrWorkspaceWithDeps = PrWorkspaceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      AiServiceWithDeps,
      AgentWorktreesWithDeps,
      PrMirrorWithDeps,
    ),
  ),
);

const ChatTurnServiceWithDeps = ChatTurnServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(BaseLayers, PrContextServiceWithDeps, AiServiceWithDeps, PrWorkspaceWithDeps),
  ),
);

const BaseConflictsServiceWithDeps = BaseConflictsServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      BaseLayers,
      PrContextServiceWithDeps,
      AiServiceWithDeps,
      PrWorkspaceWithDeps,
      PrMirrorWithDeps,
      RepoCloneServiceWithDeps,
    ),
  ),
);

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
  AgentWorktreesWithDeps,
  WalkthroughJobsWithDeps,
  HunkScanServiceWithDeps,
  ProjectRecapJobsWithDeps,
  RecapSchedulerWithDeps,
  StackBriefJobsWithDeps,
  StackReviewServiceWithDeps,
  StackMergeServiceWithDeps,
  StackRebaseServiceWithDeps,
  DbMaintenanceWithDeps,
  PrWorkspaceWithDeps,
  ChatTurnServiceWithDeps,
  BaseConflictsServiceWithDeps,
  // Settings routes (cache status, signing test) resolve these directly.
  GcsBlobStoreWithDeps,
  RemoteWalkthroughCacheWithDeps,
  WalkthroughSnapshotImporterLive,
  SshSignerWithDeps,
  CacheEligibilityWithDeps,
);
