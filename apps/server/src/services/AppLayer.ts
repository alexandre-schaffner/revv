import { Layer } from 'effect';
import { CacheStatsLive, InvalidationBusLive } from '../cache/index';
import { AiServiceLive } from './Ai';
import { DbServiceLive } from './Db';
import { DiffCacheServiceLive } from './DiffCache';
import { FileContentServiceLive } from './FileContent';
import { CacheServiceLive } from './Cache';
import { GitHubServiceLive } from './GitHub';
import { GitHubEtagCacheLive } from './GitHubEtagCache';
import { PollSchedulerLive } from './PollScheduler';
import { PrContextServiceLive } from './PrContext';
import { PullRequestServiceLive } from './PullRequest';
import { RepoCloneServiceLive } from './RepoClone';
import { RepositoryServiceLive } from './Repository';
import { ReviewServiceLive } from './Review';
import { SettingsServiceLive } from './Settings';
import { SyncServiceLive } from './Sync';
import { TokenProviderLive } from './TokenProvider';
import { WalkthroughServiceLive } from './Walkthrough';
import { WebSocketHubLive } from './WebSocketHub';

// TokenProvider now needs DbService
const TokenProviderWithDeps = TokenProviderLive.pipe(Layer.provide(DbServiceLive));

// GitHub service now depends on the etag cache for conditional requests.
const GitHubServiceWithDeps = GitHubServiceLive.pipe(Layer.provide(GitHubEtagCacheLive));

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

// PollScheduler depends on all of the above plus SyncService (for thread polling)
const PollSchedulerWithDeps = PollSchedulerLive.pipe(
	Layer.provide(Layer.mergeAll(BaseLayers, SyncServiceWithDeps)),
);

// AiService depends on DbService + SettingsService (both in BaseLayers)
const AiServiceWithDeps = AiServiceLive.pipe(Layer.provide(BaseLayers));

// RepoCloneService depends on DbService + WebSocketHub (both in BaseLayers)
const RepoCloneServiceWithDeps = RepoCloneServiceLive.pipe(Layer.provide(BaseLayers));

// AppLayer merges everything together so consumers get all services
export const AppLayer = Layer.mergeAll(
	BaseLayers,
	PrContextServiceWithDeps,
	SyncServiceWithDeps,
	PollSchedulerWithDeps,
	AiServiceWithDeps,
	RepoCloneServiceWithDeps,
);
