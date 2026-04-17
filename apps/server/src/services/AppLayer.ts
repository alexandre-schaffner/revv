import { Layer } from 'effect';
import { AiServiceLive } from './Ai';
import { DbServiceLive } from './Db';
import { DiffCacheServiceLive } from './DiffCache';
import { GitHubServiceLive } from './GitHub';
import { PollSchedulerLive } from './PollScheduler';
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

// Base layer: all services that have no deps or only depend on DbService
const BaseLayers = Layer.mergeAll(
	DbServiceLive,
	TokenProviderWithDeps,
	GitHubServiceLive,
	WebSocketHubLive,
	RepositoryServiceLive,
	PullRequestServiceLive,
	ReviewServiceLive,
	SettingsServiceLive,
	WalkthroughServiceLive,
	DiffCacheServiceLive,
);

// SyncService depends on GitHub, Review, PR, Repo, Token, WSHub — all in BaseLayers
const SyncServiceWithDeps = SyncServiceLive.pipe(Layer.provide(BaseLayers));

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
	SyncServiceWithDeps,
	PollSchedulerWithDeps,
	AiServiceWithDeps,
	RepoCloneServiceWithDeps,
);
