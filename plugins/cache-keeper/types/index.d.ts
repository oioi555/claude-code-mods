export type CacheKeeperTtl = '5m' | '1h';

/**
 * One model request of the main loop, or a keep-alive; or a compaction, which
 * leaves nothing cached for the conversation it leaves behind.
 */
export type CacheKeeperSample = {
  turnId: string;
  kind: 'turn' | 'keep-alive' | 'compact';
  /** When the request started (a compaction: when it ended): the cache lifetime counts from here. */
  at: number;
  model: string;
  read: number;
  write: number;
  fresh: number;
  output: number;
  /** A compaction's conversation size before and after, in tokens, when Claude Code recorded it. */
  before?: number;
  after?: number;
};

export type CacheKeeperTurnRow = {
  turnId: string;
  kind: CacheKeeperSample['kind'];
  steps: number;
  read: number;
  write: number;
  fresh: number;
  before?: number;
  after?: number;
};

export type CacheKeeperContext = {
  tokens?: number;
  window: number;
  percent?: number;
  /** Tokens at which Claude Code compacts on its own; absent when unknown or off. */
  autoAt?: number;
  /** Whether Claude Code compacts on its own; absent until known. */
  isAutoOn?: boolean;
};

export type CacheKeeperLimit = {
  kind: string;
  percentUsed: number;
  resetsAt?: string;
};

export type CacheKeeperStatus = {
  /** What the keeper is doing, as the band says it. */
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'dim';
  next?: 'keep-alive' | 'compact';
  dueAt?: number;
  compactAt?: number;
  isBusy: boolean;
  isPaused: boolean;
  done: number;
  planned: number;
};

export type CacheKeeperSleep = {
  platform: 'linux' | 'windows' | 'macos' | 'unsupported';
  isActive: boolean;
  error?: string;
};

/** Everything the band and the pane draw, refreshed by the module. */
export type CacheKeeperView = {
  now: number;
  ttl: CacheKeeperTtl;
  ttlSource: string;
  last?: CacheKeeperSample;
  turns: CacheKeeperTurnRow[];
  context?: CacheKeeperContext;
  limits: CacheKeeperLimit[];
  keeper: CacheKeeperStatus;
  sleep: CacheKeeperSleep;
  lastKeepAlive?: CacheKeeperSample;
  /** The main loop's model and effort, as its last request named them. */
  model?: string;
  effort?: string;
};

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      view: CacheKeeperView | null;
      /** The session's requests, kept here so a reload of the mod picks them up. */
      samples: CacheKeeperSample[];
    };
  }
}
