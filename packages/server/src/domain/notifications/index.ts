// Public barrel for the notifications domain (Waggle Pipeline + Presence Registry).

export type { SubscriberHandle } from './presence/subscriber-handle.js';
export type { SubscribeInput, Subscription, PresenceSnapshot } from './presence/types.js';
export { createPresenceRegistry } from './presence/registry.js';
export type {
  PresenceRegistry,
  PresenceRegistryConfig,
  SubscribedHookInput,
} from './presence/registry.js';

export type { WaggleNotification, WaggleKind } from './waggle/types.js';

export { createConsolidator } from './waggle/consolidator.js';
export type { Consolidator, ConsolidatorConfig, FlushCallback } from './waggle/consolidator.js';

export { createBuilder } from './waggle/builder.js';
export type { Builder, BuilderDeps } from './waggle/builder.js';

export { createReplay } from './waggle/replay.js';
export type { Replay, ReplayConfig, ReplayDeps } from './waggle/replay.js';

export { createPipeline } from './waggle/pipeline.js';
export type { Pipeline, PipelineDeps } from './waggle/pipeline.js';

export { WaggleError, isWaggleError } from './errors.js';
export type { WaggleErrorCode, WaggleErrorOptions } from './errors.js';
