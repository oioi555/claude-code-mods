// Run with: claude plugin test plugins/cache-keeper
import { describe, expect, test } from 'claude-code/testing'
import {
  MINUTE,
  accountOf,
  modelLabel,
  savedEffort,
  byTurn,
  decide,
  decideTtl,
  fmtClock,
  fmtTokens,
  freshKeeper,
  observeTtl,
  remainingMs,
  resetsIn,
  wantsAwake,
} from '../hooks/logic.ts'
import type { KeeperPolicy } from '../hooks/logic.ts'
import { inhibitorArgv, platformOf } from '../hooks/inhibitor.ts'
import type { CacheKeeperSample as Sample } from '../types'

const T0 = 1_000_000_000_000
const policy: KeeperPolicy = { isEnabled: true, marginMs: 5 * MINUTE, keepAlives: 1 }

const sample = (over: Partial<Sample> = {}): Sample => ({
  turnId: 't1',
  kind: 'turn',
  at: T0,
  model: 'claude-opus-5-5',
  read: 80_000,
  write: 1_000,
  fresh: 500,
  output: 300,
  ...over,
})

describe('which lifetime Claude Code asks for', () => {
  test('the option, then FORCE_5M, the variable, the setting, ENABLE_1H, then the account', () => {
    expect(decideTtl('1h', { force5m: '1' }, '5m', 'other')).toEqual({ ttl: '1h', source: 'option' })
    expect(decideTtl('auto', { force5m: '1', ttlVar: '1h' }, '1h', 'subscription').ttl).toBe('5m')
    expect(decideTtl('auto', { ttlVar: '5m', enable1h: '1' }, '1h', 'subscription').source).toBe('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect(decideTtl('auto', { enable1h: '1' }, '5m', 'other').source).toBe('promptCacheTtl setting')
    expect(decideTtl('auto', { enable1h: 'true' }, undefined, 'other').ttl).toBe('1h')
    expect(decideTtl('auto', {}, 'junk', 'subscription')).toEqual({ ttl: '1h', source: 'subscription' })
    expect(decideTtl('auto', {}, undefined, 'credits').ttl).toBe('5m')
    expect(decideTtl(undefined, {}, undefined, 'other').ttl).toBe('5m')
  })

  test('the account comes from the plan windows', () => {
    expect(accountOf([])).toBe('other')
    expect(accountOf([{ kind: 'spend_limit', percentUsed: 10 }])).toBe('other')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 20 }, { kind: 'seven_day', percentUsed: 5 }])).toBe('subscription')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 100 }])).toBe('credits')
  })
})

describe('observed lifetime', () => {
  test('a hit more than 5 minutes later proves 1 hour and sticks', () => {
    const hit = sample({ at: T0 + 20 * MINUTE })
    expect(observeTtl(sample(), hit, undefined)).toBe('1h')
    expect(observeTtl(hit, sample({ at: T0 + 40 * MINUTE, read: 0, write: 82_000 }), '1h')).toBe('1h')
  })

  test('a miss 5 to 60 minutes later says 5 minutes; a later hit overrules it', () => {
    const miss = sample({ at: T0 + 7 * MINUTE, read: 0, write: 82_000 })
    expect(observeTtl(sample(), miss, undefined)).toBe('5m')
    expect(observeTtl(miss, sample({ at: T0 + 20 * MINUTE }), '5m')).toBe('1h')
  })

  test('says nothing inside 5 minutes, across a model change, or after a shrink', () => {
    expect(observeTtl(sample(), sample({ at: T0 + 2 * MINUTE, read: 0, write: 82_000 }), undefined)).toBeUndefined()
    expect(observeTtl(sample(), sample({ at: T0 + 20 * MINUTE, model: 'claude-sonnet-5-5', read: 0 }), undefined)).toBeUndefined()
    expect(observeTtl(sample(), sample({ at: T0 + 20 * MINUTE, read: 0, write: 5_000 }), undefined)).toBeUndefined()
  })
})

describe('the keeper', () => {
  const armed = () => ({ ...freshKeeper(), isArmed: true })

  test('waits, then keeps alive before the lapse, then compacts', () => {
    const last = sample()
    const waiting = decide(armed(), policy, '1h', last, T0 + 10 * MINUTE)
    expect(waiting.action).toBe('none')
    expect(waiting.next).toBe('keep-alive')
    expect(waiting.dueAt).toBe(T0 + 55 * MINUTE)
    expect(waiting.compactAt).toBe(T0 + 110 * MINUTE)
    expect(waiting.label).toBe('keep-alive 45:00 → compact 1:40:00')
    expect(wantsAwake(waiting)).toBe(true)

    expect(decide(armed(), policy, '1h', last, T0 + 55 * MINUTE).action).toBe('keep-alive')

    const afterOne = { ...armed(), done: 1 }
    const refreshed = sample({ kind: 'keep-alive', at: T0 + 55 * MINUTE })
    const d = decide(afterOne, policy, '1h', refreshed, T0 + 60 * MINUTE)
    expect(d.next).toBe('compact')
    expect(d.dueAt).toBe(T0 + 110 * MINUTE)
    expect(decide(afterOne, policy, '1h', refreshed, T0 + 110 * MINUTE).action).toBe('compact')
  })

  test('a cache that lapsed while away is left alone', () => {
    expect(decide(armed(), policy, '1h', sample(), T0 + 61 * MINUTE).action).toBe('expired')
  })

  test('stays out of the way: unarmed, paused, 5-minute cache, off, finished', () => {
    const now = T0 + 56 * MINUTE
    expect(decide(freshKeeper(), policy, '1h', sample(), now).action).toBe('none')
    expect(decide({ ...armed(), isPaused: true }, policy, '1h', sample(), now).action).toBe('none')
    expect(decide(armed(), policy, '5m', sample(), T0 + 4 * MINUTE).action).toBe('none')
    expect(decide(armed(), { ...policy, isEnabled: false }, '1h', sample(), now).action).toBe('none')
    expect(decide({ ...armed(), outcome: 'compacted' }, policy, '1h', sample(), now).action).toBe('none')
    expect(wantsAwake(decide(freshKeeper(), policy, '1h', sample(), now))).toBe(false)
  })

  test('keepAlives 0 compacts at the first deadline', () => {
    const d = decide(armed(), { ...policy, keepAlives: 0 }, '1h', sample(), T0 + 55 * MINUTE)
    expect(d.action).toBe('compact')
  })

  test('the margin stays inside half the lifetime', () => {
    const d = decide(armed(), { ...policy, marginMs: 50 * MINUTE }, '1h', sample(), T0)
    expect(d.dueAt).toBe(T0 + 30 * MINUTE)
  })
})

describe('helpers', () => {
  test('countdown and formatting', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('opus')).toBe('opus')
    const saved = { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }
    expect(savedEffort(saved, ['claude-opus-5-5[1m]', 'opus'])).toBe('high')
    expect(savedEffort(saved, [undefined, 'claude-sonnet-5-5'])).toBe('medium')
    expect(savedEffort(saved, [undefined, 'opus'])).toBe('high')
    expect(remainingMs(sample(), '1h', T0 + 10 * MINUTE)).toBe(50 * MINUTE)
    expect(remainingMs(sample({ read: 0, write: 0 }), '1h', T0)).toBe(0)
    expect(fmtClock(200_000)).toBe('3:20')
    expect(fmtClock(3_600_000)).toBe('1:00:00')
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(84_200)).toBe('84.2k')
    expect(fmtTokens(182_000)).toBe('182k')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
    expect(resetsIn(new Date(T0 + 125 * MINUTE).toISOString(), T0)).toBe('2h05m')
    expect(resetsIn(new Date(T0 + 50 * 60 * MINUTE).toISOString(), T0)).toBe('2d2h')
  })

  test('turns group their steps; a keep-alive is a row of its own', () => {
    const rows = byTurn([sample(), sample({ read: 1_000 }), sample({ turnId: 'ka', kind: 'keep-alive' })])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.steps).toBe(2)
    expect(rows[0]?.read).toBe(81_000)
    expect(rows[1]?.kind).toBe('keep-alive')
  })

  test('the sleep hold per platform', () => {
    expect(platformOf('Windows_NT', undefined)).toBe('windows')
    expect(platformOf(undefined, 'Linux\n')).toBe('linux')
    expect(platformOf(undefined, 'Darwin')).toBe('macos')
    expect(platformOf(undefined, 'FreeBSD')).toBe('unsupported')
    expect(inhibitorArgv('linux')?.[0]).toBe('systemd-inhibit')
    expect(inhibitorArgv('windows')?.[0]).toBe('powershell.exe')
    expect(inhibitorArgv('macos')).toEqual(['caffeinate', '-i'])
    expect(inhibitorArgv('unsupported')).toBeUndefined()
  })
})
