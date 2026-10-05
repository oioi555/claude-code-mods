// Pure logic for cache-keeper: no `$`, so the tests call it directly.
import type {
  CacheKeeperLimit as Limit,
  CacheKeeperSample as Sample,
  CacheKeeperStatus as Status,
  CacheKeeperTtl as Ttl,
  CacheKeeperTurnRow as TurnRow,
} from '../types'

export const MINUTE = 60_000
export const TTL_MS: Record<Ttl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

// ---------------------------------------------------------------- lifetime

export type Account = 'subscription' | 'credits' | 'other'

export type TtlEnv = {
  force5m?: string
  ttlVar?: string
  enable1h?: string
}

const isOn = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())
const asTtl = (v: unknown): Ttl | undefined => (v === '5m' || v === '1h' ? v : undefined)

/** A plan window says subscription; one used up means requests draw on usage credits. */
export function accountOf(limits: readonly Limit[]): Account {
  const plan = limits.filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
  if (plan.length === 0) return 'other'
  return plan.some(l => l.percentUsed >= 100) ? 'credits' : 'subscription'
}

/** The lifetime Claude Code asks for, in the order its documentation gives. */
export function decideTtl(option: unknown, env: TtlEnv, setting: unknown, account: Account): { ttl: Ttl; source: string } {
  const pinned = asTtl(option)
  if (pinned) return { ttl: pinned, source: 'option' }
  if (isOn(env.force5m)) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  const fromVar = asTtl(env.ttlVar?.trim())
  if (fromVar) return { ttl: fromVar, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const fromSetting = asTtl(setting)
  if (fromSetting) return { ttl: fromSetting, source: 'promptCacheTtl setting' }
  if (isOn(env.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  if (account === 'subscription') return { ttl: '1h', source: 'subscription' }
  return { ttl: '5m', source: account === 'credits' ? 'usage credits' : 'API key or provider' }
}

export const promptTokens = (s: Sample) => s.read + s.write + s.fresh
export const isCached = (s: Sample | undefined) => !!s && s.read + s.write > 0
export const hitRatio = (s: Sample) => (promptTokens(s) > 0 ? s.read / promptTokens(s) : 0)

/**
 * What the gap between two requests proves about the lifetime. A hit after
 * more than 5 minutes proves 1 hour and sticks (a later miss may be a changed
 * prefix); a miss 5 to 60 minutes later on the same model, with a prompt that
 * did not shrink, says 5 minutes until a hit overrules it.
 */
export function observeTtl(prev: Sample | undefined, cur: Sample, seen: Ttl | undefined): Ttl | undefined {
  if (!prev || !isCached(prev) || prev.model !== cur.model) return seen
  const gap = cur.at - prev.at
  if (gap <= TTL_MS['5m']) return seen
  const before = promptTokens(prev)
  if (before === 0) return seen
  if (cur.read >= before * 0.5) return '1h'
  const isMiss = cur.read < before * 0.1 && promptTokens(cur) >= before * 0.9
  if (isMiss && gap < TTL_MS['1h'] && seen !== '1h') return '5m'
  return seen
}

export function remainingMs(last: Sample | undefined, ttl: Ttl, now: number): number {
  if (!last || !isCached(last)) return 0
  return Math.max(0, last.at + TTL_MS[ttl] - now)
}

// ---------------------------------------------------------------- keeper

export type KeeperPolicy = {
  isEnabled: boolean
  marginMs: number
  keepAlives: number
}

export type KeeperState = {
  /** Set when a main turn completed; cleared when the person is back. */
  isArmed: boolean
  busy?: 'keep-alive' | 'compact'
  done: number
  outcome?: 'compacted' | 'expired' | 'failed'
  isPaused: boolean
}

export type Decision = Status & { action: 'none' | 'keep-alive' | 'compact' | 'expired' }

export const freshKeeper = (): KeeperState => ({ isArmed: false, done: 0, isPaused: false })

/** The margin, kept between 30 s and half the lifetime. */
export function marginFor(policy: KeeperPolicy, ttl: Ttl): number {
  return Math.min(Math.max(policy.marginMs, 30_000), TTL_MS[ttl] / 2)
}

/** What the keeper should do now, and what the band says about it. */
export function decide(k: KeeperState, policy: KeeperPolicy, ttl: Ttl, last: Sample | undefined, now: number): Decision {
  const base = { isBusy: !!k.busy, isPaused: k.isPaused, done: k.done, planned: policy.keepAlives }
  const say = (label: string, tone: Status['tone'], action: Decision['action'] = 'none'): Decision => ({ ...base, label, tone, action })

  if (!policy.isEnabled) return say('keeper off', 'dim')
  if (k.busy === 'keep-alive') return say('keep-alive running', 'warn')
  if (k.busy === 'compact') return say('compacting', 'warn')
  if (k.outcome === 'compacted') return say('compacted while idle', 'ok')
  if (k.outcome === 'expired') return say('expired while away', 'bad')
  if (k.outcome === 'failed') return say('keeper failed (see /ttl)', 'bad')
  if (k.isPaused) return say('paused', 'dim')
  if (ttl !== '1h') return say('idle (5m cache: keeper off)', 'dim')
  if (!isCached(last)) return say(k.isArmed ? 'idle (nothing cached)' : 'ready', 'dim')
  if (!k.isArmed) return say('ready', 'dim')

  const ttlMs = TTL_MS[ttl]
  const margin = marginFor(policy, ttl)
  const expiresAt = last!.at + ttlMs
  if (now >= expiresAt) return say('expired while away', 'bad', 'expired')
  const dueAt = expiresAt - margin
  const left = Math.max(0, policy.keepAlives - k.done)
  const next = left > 0 ? 'keep-alive' : 'compact'
  const compactAt = dueAt + left * (ttlMs - margin)
  const status = { ...base, next, dueAt, compactAt } as const
  if (now >= dueAt) return { ...status, label: next === 'keep-alive' ? 'keep-alive due' : 'compact due', tone: 'warn', action: next }
  const label = next === 'keep-alive'
    ? `keep-alive ${fmtClock(dueAt - now)} → compact ${fmtClock(compactAt - now)}`
    : `compact ${fmtClock(dueAt - now)}`
  return { ...status, label, tone: 'ok', action: 'none' }
}

/** Whether the machine should be kept awake for what the keeper has pending. */
export const wantsAwake = (d: Decision) => d.isBusy || d.dueAt !== undefined

// ---------------------------------------------------------------- tables

export function byTurn(samples: readonly Sample[]): TurnRow[] {
  const rows: TurnRow[] = []
  for (const s of samples) {
    const row = rows[rows.length - 1]
    if (row && row.turnId === s.turnId) {
      row.steps += 1
      row.read += s.read
      row.write += s.write
      row.fresh += s.fresh
    } else {
      rows.push({ turnId: s.turnId, kind: s.kind, steps: 1, read: s.read, write: s.write, fresh: s.fresh })
    }
  }
  return rows
}

// ---------------------------------------------------------------- formatting

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(Math.round(n))
}
const trim = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ''))

export function bar(ratio: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
export const limitLabel = (kind: string) => LIMIT_LABEL[kind] ?? kind

/** Green well below where Claude Code compacts on its own, yellow nearing it, red at it. */
export function contextTone(tokens: number | undefined, window: number, autoAt: number | undefined): 'green' | 'yellow' | 'red' {
  if (tokens === undefined) return 'green'
  const limit = autoAt ?? window
  const r = tokens / limit
  return r >= 0.9 ? 'red' : r >= 0.7 ? 'yellow' : 'green'
}

export const percentTone = (p: number): 'green' | 'yellow' | 'red' => (p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green')

/** Green, then yellow below 40% of the lifetime, red inside the last minute. */
export function lifeTone(left: number, ttl: Ttl): 'green' | 'yellow' | 'red' {
  if (left <= 60_000) return 'red'
  return left / TTL_MS[ttl] < 0.4 ? 'yellow' : 'green'
}

export function resetsIn(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  const ms = at - now
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3_600_000)
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export function positive(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
