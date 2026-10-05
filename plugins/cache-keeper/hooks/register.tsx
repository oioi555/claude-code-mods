/**
 * cache-keeper — Claude Code mod
 *
 * Meters: the context window (with the point where Claude Code compacts on its
 * own), the plan's rate-limit windows, and the prompt cache (hit rate and the
 * countdown to its expiry), as two rows above the prompt and a /ttl pane.
 *
 * Keeper: once a main turn completes on a 1-hour cache, it refreshes the cache
 * with a tool-less `$.model.fork()` shortly before it lapses (`keepAlives`
 * times), then compacts the session before the next lapse. The person coming
 * back cancels it. While something is pending, a child process holds off idle
 * sleep (systemd-inhibit, SetThreadExecutionState through PowerShell, or
 * caffeinate). A cache that lapsed anyway (the machine slept) is left alone:
 * a keep-alive then would only pay to write it again.
 *
 * Every function that takes `$` is declared at the top of this file, as the
 * engine requires; the session's values live in one Runtime object.
 */
import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  PluginOptions,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'
import type {
  CacheKeeperContext as Context,
  CacheKeeperLimit as Limit,
  CacheKeeperSample as Sample,
  CacheKeeperSleep as Sleep,
  CacheKeeperTtl as Ttl,
  CacheKeeperView as View,
} from '../types'
import {
  MINUTE,
  TTL_MS,
  accountOf,
  bar,
  byTurn,
  contextTone,
  decide,
  decideTtl,
  fmtClock,
  fmtTokens,
  freshKeeper,
  hitRatio,
  isCached,
  lifeTone,
  limitLabel,
  observeTtl,
  percentTone,
  positive,
  promptTokens,
  remainingMs,
  resetsIn,
  wantsAwake,
} from './logic.ts'
import type { KeeperPolicy, KeeperState, TtlEnv } from './logic.ts'
import { inhibitorArgv, platformOf } from './inhibitor.ts'

const PANE = 'cache-keeper'
const COMMAND = 'ttl'
const KEEP = 200
const KEEP_ALIVE_PROMPT = 'Reply with exactly one character: .'
const MAX_SLEEP_FAILURES = 3

const viewAtom = atom({ plugin: 'cache-keeper', key: 'view' } as const, null)

const TONE = { ok: 'green', warn: 'yellow', bad: 'red', dim: undefined } as const

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

type Runtime = {
  policy: KeeperPolicy
  ttlOption: unknown
  holdSleep: boolean
  showStatus: boolean
  samples: Sample[]
  lastKeepAlive?: Sample
  keeper: KeeperState
  /** Bumped whenever the keeper starts over, so late answers of an old run are dropped. */
  generation: number
  keeperError?: string
  env: TtlEnv
  setting: unknown
  limits: Limit[]
  context?: Context
  observed?: Ttl
  ttl: Ttl
  ttlSource: string
  platform: Sleep['platform']
  child?: Child
  sleepFailures: number
  sleepError?: string
  timer?: { cancel: () => void }
  isTicking: boolean
  lastKey: string
  lastStatus: string
}

function createRuntime(options: PluginOptions): Runtime {
  const policy: KeeperPolicy = {
    isEnabled: options.keeper !== false,
    marginMs: positive(options.marginMinutes, 5) * MINUTE,
    keepAlives: Math.min(5, Math.floor(positive(options.keepAlives, 1))),
  }
  return {
    policy,
    ttlOption: options.ttl,
    holdSleep: options.inhibitSleep !== false && policy.isEnabled,
    showStatus: options.status === true,
    samples: [],
    keeper: freshKeeper(),
    generation: 0,
    env: {},
    setting: undefined,
    limits: [],
    ttl: '5m',
    ttlSource: 'default',
    platform: 'unsupported',
    sleepFailures: 0,
    isTicking: false,
    lastKey: '',
    lastStatus: '',
  }
}

const toLimit = (l: SessionRateLimit): Limit => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })

// The last plan windows any session saw: a new session reads them until its
// first response, so a subscription starts on its 1-hour lifetime
const LIMITS_KEY = 'limits'

function isLimitList(v: unknown): v is Limit[] {
  return Array.isArray(v) && v.every(l => typeof l?.kind === 'string' && typeof l?.percentUsed === 'number')
}

async function setLimits($: EngineInterface, rt: Runtime, limits: Limit[]) {
  rt.limits = limits
  if (limits.length > 0) await $.store.set(LIMITS_KEY, limits).catch(() => undefined)
}

// The host puts the plugin's name before each line
function log($: EngineInterface, text: string, to: 'transcript' | 'debug' = 'transcript') {
  $.ui.log(text, { to })
}

function settleTtl(rt: Runtime) {
  const choice = decideTtl(rt.ttlOption, rt.env, rt.setting, accountOf(rt.limits))
  if (choice.source === 'option' || rt.observed === undefined || rt.observed === choice.ttl) {
    rt.ttl = choice.ttl
    rt.ttlSource = choice.source
  } else {
    rt.ttl = rt.observed
    rt.ttlSource = `observed; ${choice.source} says ${choice.ttl}`
  }
}

function setContext(rt: Runtime, c: SessionContextUsage) {
  rt.context = { ...rt.context, tokens: c.tokens, window: c.window, percent: c.percent }
}

function forgetFill(rt: Runtime) {
  if (rt.context) rt.context = { ...rt.context, tokens: undefined, percent: undefined }
}

function startOver(rt: Runtime) {
  rt.generation += 1
  rt.keeper = { ...freshKeeper(), isPaused: rt.keeper.isPaused }
  rt.keeperError = undefined
}

// The plain figures, plus where Claude Code compacts on its own (a local estimate)
async function refreshUsage($: EngineInterface, rt: Runtime) {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  if (!usage) return
  setContext(rt, usage.context)
  const b = usage.context.breakdown
  if (b && rt.context) {
    rt.context.isAutoOn = b.isAutoCompactEnabled
    rt.context.autoAt = b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
  }
  if (usage.rateLimits.length > 0) await setLimits($, rt, usage.rateLimits.map(toLimit))
  else if (rt.limits.length === 0) {
    const saved = await $.store.get(LIMITS_KEY).catch(() => undefined)
    if (isLimitList(saved)) rt.limits = saved
  }
  settleTtl(rt)
}

function record($: EngineInterface, rt: Runtime, s: Sample) {
  const prev = rt.samples[rt.samples.length - 1]
  rt.samples.push(s)
  if (rt.samples.length > KEEP) rt.samples = rt.samples.slice(-KEEP)
  const seen = observeTtl(prev, s, rt.observed)
  if (seen !== rt.observed) {
    rt.observed = seen
    log($, `cache lifetime looks like ${seen} from request timing`, 'debug')
  }
  settleTtl(rt)
}

// ------------------------------------------------------------ sleep hold

async function detectPlatform($: EngineInterface): Promise<Sleep['platform']> {
  const osVar = await $.env.get('OS').catch(() => undefined)
  if (osVar === 'Windows_NT') return 'windows'
  const uname = await $.process
    .run(['uname', '-s'], { timeoutMs: 3_000 })
    .then(r => r.stdout)
    .catch(() => undefined)
  return platformOf(osVar, uname)
}

async function holdSleep($: EngineInterface, rt: Runtime, isWanted: boolean) {
  if (!isWanted) {
    const mine = rt.child
    if (!mine) return
    rt.child = undefined
    await mine.return(undefined as never).catch(() => undefined)
    return
  }
  const argv = inhibitorArgv(rt.platform)
  if (rt.child || !argv || rt.sleepFailures >= MAX_SLEEP_FAILURES) return
  const mine = $.process.spawn({ argv })
  rt.child = mine
  rt.sleepError = undefined
  void watchHold($, rt, mine, argv[0] ?? 'inhibitor')
}

// Drains the child's output; a child that ends while still held has failed
async function watchHold($: EngineInterface, rt: Runtime, mine: Child, name: string) {
  let stderr = ''
  try {
    for await (const piece of mine) {
      if (piece.stream === 'stderr') stderr = (stderr + piece.text).slice(-300)
    }
    if (rt.child === mine) {
      const { code, signal } = await mine.result
      rt.sleepFailures += 1
      rt.sleepError = `${name} exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`
    }
  } catch (err) {
    if (rt.child === mine) {
      rt.sleepFailures += 1
      rt.sleepError = `${name} did not start: ${err}`
    }
  }
  if (rt.child === mine) {
    rt.child = undefined
    if (rt.sleepError) log($, rt.sleepError, 'debug')
    await publish($, rt)
  }
}

// ------------------------------------------------------------ the keeper

async function publish($: EngineInterface, rt: Runtime) {
  const now = await $.clock.now()
  const last = rt.samples[rt.samples.length - 1]
  const { action: _, ...status } = decide(rt.keeper, rt.policy, rt.ttl, last, now)
  if (rt.holdSleep) await holdSleep($, rt, wantsAwake({ ...status, action: 'none' }))
  // Redraw by the tick only while something counts down
  const isCounting = remainingMs(last, rt.ttl, now) > 0 || status.dueAt !== undefined
  const sleep: Sleep = rt.holdSleep
    ? { platform: rt.platform, isActive: rt.child !== undefined, error: rt.sleepError ?? (inhibitorArgv(rt.platform) ? undefined : 'no sleep inhibitor on this platform') }
    : { platform: rt.platform, isActive: false, error: 'off' }
  const view: View = {
    now: isCounting ? now : Math.floor(now / MINUTE) * MINUTE,
    ttl: rt.ttl,
    ttlSource: rt.ttlSource,
    last,
    turns: byTurn(rt.samples).slice(-20),
    context: rt.context,
    limits: rt.limits,
    keeper: status,
    sleep,
    lastKeepAlive: rt.lastKeepAlive,
  }
  const key = JSON.stringify(view)
  if (key !== rt.lastKey) {
    rt.lastKey = key
    await update($, viewAtom, () => view)
  }
  if (rt.showStatus) {
    const text = statusLine(view, now)
    if (text !== rt.lastStatus) {
      rt.lastStatus = text
      $.ui.status(text)
    }
  }
}

async function keepAlive($: EngineInterface, rt: Runtime, isScheduled: boolean) {
  if (rt.keeper.busy) return
  const mine = rt.generation
  rt.keeper.busy = 'keep-alive'
  const at = await $.clock.now()
  const model = rt.samples[rt.samples.length - 1]?.model ?? ''
  try {
    const r = await $.model.fork({ prompt: KEEP_ALIVE_PROMPT })
    if (mine !== rt.generation) return
    if (!r.isAnswered) throw new Error(`keep-alive not answered (${r.reason})`)
    const s: Sample = {
      turnId: `keep-alive-${at}`,
      kind: 'keep-alive',
      at,
      model,
      read: r.usage.cache_read_input_tokens,
      write: r.usage.cache_creation_input_tokens,
      fresh: r.usage.input_tokens,
      output: r.usage.output_tokens,
    }
    record($, rt, s)
    rt.lastKeepAlive = s
    if (isScheduled) rt.keeper.done += 1
    log($, `keep-alive: read ${fmtTokens(s.read)}, wrote ${fmtTokens(s.write)}, new ${fmtTokens(s.fresh)} tokens`)
  } catch (err) {
    if (mine !== rt.generation) return
    rt.keeper.outcome = 'failed'
    rt.keeperError = String(err)
    log($, rt.keeperError, 'debug')
  } finally {
    if (mine === rt.generation) rt.keeper.busy = undefined
    await publish($, rt)
  }
}

async function compact($: EngineInterface, rt: Runtime) {
  if (rt.keeper.busy) return
  const mine = rt.generation
  rt.keeper.busy = 'compact'
  try {
    const r = await $.session.compact()
    if (mine !== rt.generation) return
    if (r.skip !== undefined) throw new Error(`compact skipped: ${r.skip}`)
    rt.keeper.outcome = 'compacted'
  } catch (err) {
    if (mine !== rt.generation) return
    rt.keeper.outcome = 'failed'
    rt.keeperError = String(err)
    log($, rt.keeperError, 'debug')
  } finally {
    if (mine === rt.generation) rt.keeper.busy = undefined
    await publish($, rt)
  }
}

async function tick($: EngineInterface, rt: Runtime) {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    const now = await $.clock.now()
    const d = decide(rt.keeper, rt.policy, rt.ttl, rt.samples[rt.samples.length - 1], now)
    if (d.action === 'keep-alive') void keepAlive($, rt, true)
    else if (d.action === 'compact') void compact($, rt)
    else if (d.action === 'expired') {
      rt.keeper.outcome = 'expired'
      log($, 'the cache lapsed while away (the machine slept?); keep-alive and compact skipped')
    }
    await publish($, rt)
  } finally {
    rt.isTicking = false
  }
}

async function startSession($: EngineInterface, rt: Runtime) {
  rt.samples = []
  rt.lastKeepAlive = undefined
  rt.keeper = freshKeeper()
  rt.generation += 1
  rt.observed = undefined
  const none = () => undefined
  rt.env = {
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
    ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
  }
  const settings = (await $.settings.read().catch(() => ({}))) as Record<string, unknown>
  rt.setting = settings.promptCacheTtl
  await refreshUsage($, rt)
  settleTtl(rt)
  if (rt.holdSleep) rt.platform = await detectPlatform($)

  await $.command
    .register({
      name: COMMAND,
      description: 'Cache, context and keeper details (args: pause, resume, now, compact, stop)',
      argumentHint: '[pause|resume|now|compact|stop]',
      immediate: true,
    })
    .catch(err => log($, `/${COMMAND} not registered: ${err}`, 'debug'))

  rt.timer?.cancel()
  rt.timer = $.clock.every(1000, () => tick($, rt))
  log($, `loaded: ${rt.ttl} cache (${rt.ttlSource}), sleep hold ${rt.holdSleep ? rt.platform : 'off'}`, 'debug')
  await publish($, rt)
}

async function runCommand($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const arg = args.trim().toLowerCase()
  if (arg === 'stop' || arg === 'close') {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return 'pane closed'
  }
  if (arg === 'pause' || arg === 'resume') {
    rt.keeper.isPaused = arg === 'pause'
    await publish($, rt)
    return arg === 'pause' ? 'paused for this session' : 'resumed'
  }
  if (arg === 'now') {
    void keepAlive($, rt, false)
    return 'keep-alive started'
  }
  if (arg === 'compact') {
    void compact($, rt)
    return 'compact started'
  }
  await $.ui.open({ id: PANE, title: 'cache-keeper', focus: true })
  return `${rt.ttl} cache (${rt.ttlSource}) · /${COMMAND} pause|resume|now|compact|stop`
}

function togglePause($: EngineInterface, rt: Runtime) {
  rt.keeper.isPaused = !rt.keeper.isPaused
  void publish($, rt)
}

// ------------------------------------------------------------ hooks

export const register: Register = (on, options) => {
  const rt = createRuntime(options)
  const showBand = options.band !== false
  const showQuota = options.quota !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSession($, rt)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // A new conversation in the same process: its cache is a new one
      rt.samples = []
      rt.lastKeepAlive = undefined
      rt.observed = undefined
      startOver(rt)
      forgetFill(rt)
      settleTtl(rt)
      await publish($, rt)
      return next(e)
    }
    rt.timer?.cancel()
    rt.timer = undefined
    rt.generation += 1
    await holdSleep($, rt, false)
    return next(e)
  })

  // The person is back: whatever the keeper had pending is off
  on('prompt.submit', async ($, e, next) => {
    startOver(rt)
    await publish($, rt)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!rt.keeper.busy) {
      startOver(rt)
      await publish($, rt)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !rt.keeper.busy) {
      rt.keeper.isArmed = true
      await publish($, rt)
    }
    return result
  })

  // Each main-loop request: what the cache did with it
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || rt.keeper.busy === 'keep-alive') return yield* next(e)
    const at = await $.clock.now()
    const r = yield* next(e)
    if (r.usage) {
      record($, rt, {
        turnId: e.turnId,
        kind: 'turn',
        at,
        model: r.usage.model || e.model,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
        output: r.usage.output_tokens,
      })
      await publish($, rt)
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const window = rt.context?.window
    setContext(rt, e.context)
    if (e.changed.includes('rateLimits')) await setLimits($, rt, e.rateLimits.map(toLimit))
    settleTtl(rt)
    // A new model may bring a new window and a new auto-compact point
    if (window !== undefined && window !== e.context.window) await refreshUsage($, rt)
    await publish($, rt)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      forgetFill(rt)
      if (e.trigger === 'plugin' && rt.keeper.busy === 'compact') {
        log($, `compacted while idle (${fmtTokens(result.tokensBefore ?? 0)} -> ${fmtTokens(result.tokensAfter ?? 0)} tokens)`)
      }
      await refreshUsage($, rt)
      await publish($, rt)
    }
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, rt, e.args) }))

  // ------------------------------------------------------------ the band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const view = await read($, viewAtom)
    if (!view) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const isWide = columns >= 100
    const now = view.now

    const c = view.context
    const pct = c?.tokens !== undefined ? (c.percent ?? Math.round((c.tokens / c.window) * 100)) : undefined
    const ctxTone = c ? contextTone(c.tokens, c.window, c.autoAt) : 'green'
    const ctxRow = (
      <Box key="ctx" flexDirection="row" columnGap={1}>
        <Text bold color="cyan">ctx</Text>
        {c && pct !== undefined ? (
          <Box flexDirection="row" columnGap={1}>
            <Text color={ctxTone}>{bar(pct / 100, isWide ? 10 : 6)}</Text>
            <Text bold color={ctxTone}>{`${pct}%`}</Text>
            {isWide ? <Text dimColor>{`${fmtTokens(c.tokens ?? 0)}/${fmtTokens(c.window)}`}</Text> : null}
          </Box>
        ) : (
          <Text dimColor>--</Text>
        )}
        {c?.autoAt !== undefined ? <Text dimColor>{`▸auto ${fmtTokens(c.autoAt)}`}</Text> : c?.isAutoOn === false ? <Text dimColor>auto off</Text> : null}
        {showQuota
          ? view.limits.map(l => (
              <Text key={`q:${l.kind}`} color={percentTone(l.percentUsed)}>
                {`· ${limitLabel(l.kind)} ${Math.round(l.percentUsed)}%${isWide && resetsIn(l.resetsAt, now) ? ` ↻${resetsIn(l.resetsAt, now)}` : ''}`}
              </Text>
            ))
          : null}
      </Box>
    )

    const last = view.last
    const left = remainingMs(last, view.ttl, now)
    const cacheColor = left > 0 ? lifeTone(left, view.ttl) : 'red'
    const icon = !isCached(last) ? '○' : left > 0 ? '●' : '✖'
    const k = view.keeper
    const cacheRow = (
      <Box key="cache" flexDirection="row" columnGap={1}>
        <Text bold color={isCached(last) ? cacheColor : undefined}>{icon}</Text>
        <Text bold color="cyan">cache</Text>
        {last && isCached(last) ? (
          <Box flexDirection="row" columnGap={1}>
            {isWide ? <Text bold>{`${Math.round(hitRatio(last) * 100)}%`}</Text> : null}
            <Text bold color={cacheColor}>{left > 0 ? `⏱ ${fmtClock(left)}` : 'expired'}</Text>
          </Box>
        ) : (
          <Text dimColor>--</Text>
        )}
        <Text dimColor>{view.ttl}</Text>
        <Text color={TONE[k.tone]} dimColor={k.tone === 'dim'} wrap="truncate-end">{`· ${k.label}${view.sleep.isActive ? ' · sleep held' : ''}`}</Text>
      </Box>
    )

    const mine = (
      <Box key="cache-keeper" flexDirection="column">
        {ctxRow}
        {cacheRow}
      </Box>
    )
    // Keep what the mods after this one draw in the band
    const rest = await next(e)
    if (!rest) return mine
    return (
      <Box flexDirection="column">
        {mine}
        {rest}
      </Box>
    )
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    // HTML collapses runs of spaces; a no-break space keeps the columns
    const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
    if (!view) return <Text dimColor>no data yet</Text>
    const width = Math.max(30, (e.props.bodyColumns ?? 60) - 1)
    const barW = Math.min(width - 24, 30)
    const now = view.now
    const last = view.last
    const left = remainingMs(last, view.ttl, now)
    const k = view.keeper
    const c = view.context
    const row = (key: string, label: string, value: string, color?: string) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={10} flexShrink={0}>
          <Text dimColor>{sp(label)}</Text>
        </Box>
        <Text color={color}>{sp(value)}</Text>
      </Box>
    )
    const cell = (key: string, w: number, text: string, color?: string) => (
      <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
        <Text color={color} dimColor={!color}>{sp(text)}</Text>
      </Box>
    )
    const rows = view.turns.slice(-Math.max(3, (e.viewport?.rows ?? 30) - 24))

    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{sp(`CACHE KEEPER · ${view.ttl} lifetime (${view.ttlSource})`)}</Text>

        <Box key="cache" flexDirection="column" marginTop={1}>
          <Text bold>cache</Text>
          {last && isCached(last) ? (
            <Box flexDirection="column">
              {row('left', 'left', `${bar(left / TTL_MS[view.ttl], barW)} ${left > 0 ? fmtClock(left) : 'expired'}`, left > 0 ? lifeTone(left, view.ttl) : 'red')}
              {row('last', 'last req', `${Math.round(hitRatio(last) * 100)}% hit · read ${fmtTokens(last.read)} · wrote ${fmtTokens(last.write)} · new ${fmtTokens(last.fresh)} · ${fmtTokens(promptTokens(last))} prompt`)}
            </Box>
          ) : (
            <Text dimColor>no cached request yet</Text>
          )}
        </Box>

        <Box key="context" flexDirection="column" marginTop={1}>
          <Text bold>context</Text>
          {c && c.tokens !== undefined
            ? row('ctx', 'window', `${bar(c.tokens / c.window, barW)} ${fmtTokens(c.tokens)}/${fmtTokens(c.window)}`, contextTone(c.tokens, c.window, c.autoAt))
            : row('ctx', 'window', c ? `-- of ${fmtTokens(c.window)} (until the next response)` : '--')}
          {row('auto', 'auto', c?.autoAt !== undefined ? `Claude Code compacts at ${fmtTokens(c.autoAt)}${c.tokens !== undefined ? ` (${fmtTokens(Math.max(0, c.autoAt - c.tokens))} left)` : ''}` : c?.isAutoOn === false ? 'off' : 'unknown')}
          {view.limits.map(l =>
            row(`q:${l.kind}`, limitLabel(l.kind), `${bar(l.percentUsed / 100, barW)} ${Math.round(l.percentUsed)}%${resetsIn(l.resetsAt, now) ? ` · resets in ${resetsIn(l.resetsAt, now)}` : ''}`, percentTone(l.percentUsed)),
          )}
        </Box>

        <Box key="keeper" flexDirection="column" marginTop={1}>
          <Text bold>keeper</Text>
          {row('state', 'state', k.label, TONE[k.tone])}
          {k.dueAt !== undefined ? row('next', 'next', `${k.next} in ${fmtClock(k.dueAt - now)}`) : null}
          {k.compactAt !== undefined ? row('compact', 'compact', `in ${fmtClock(k.compactAt - now)}`) : null}
          {row('done', 'keep-alive', `${k.done}/${k.planned} this idle${view.lastKeepAlive ? ` · last read ${fmtTokens(view.lastKeepAlive.read)}, wrote ${fmtTokens(view.lastKeepAlive.write)}` : ''}`)}
          {row('sleep', 'sleep', view.sleep.isActive ? `held (${view.sleep.platform})` : view.sleep.error ? `not held: ${view.sleep.error}` : `not held (${view.sleep.platform})`, view.sleep.isActive ? 'green' : undefined)}
          {rt.keeperError ? row('error', 'error', rt.keeperError, 'red') : null}
          <Box key="buttons" flexDirection="row" columnGap={1} marginTop={1}>
            <Button key="now" label="keep-alive now" hotkey="k" onPress={() => void keepAlive($, rt, false)} />
            <Button key="compact" label="compact now" hotkey="c" onPress={() => void compact($, rt)} />
            <Button key="pause" label={k.isPaused ? 'resume' : 'pause'} hotkey="p" onPress={() => togglePause($, rt)} />
            <Button key="close" label="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          </Box>
        </Box>

        <Box key="table" flexDirection="column" marginTop={1}>
          <Box key="head" flexDirection="row" columnGap={1}>
            {cell('h:n', 4, 'turn', 'cyan')}
            {cell('h:steps', 5, 'steps', 'cyan')}
            {cell('h:read', 7, 'read', 'green')}
            {cell('h:wrote', 7, 'wrote', 'yellow')}
            {cell('h:new', 6, 'new', 'cyan')}
            {cell('h:hit', 5, 'hit', 'magenta')}
          </Box>
          {rows.length === 0 ? <Text dimColor>no requests yet</Text> : null}
          {rows.map((t, i) => {
            const total = t.read + t.write + t.fresh
            const hit = total > 0 ? Math.round((t.read / total) * 100) : 0
            return (
              <Box key={`t:${t.turnId}`} flexDirection="row" columnGap={1}>
                {cell(`n:${t.turnId}`, 4, t.kind === 'keep-alive' ? 'ka' : String(view.turns.length - rows.length + i + 1))}
                {cell(`s:${t.turnId}`, 5, String(t.steps))}
                {cell(`r:${t.turnId}`, 7, fmtTokens(t.read), 'green')}
                {cell(`w:${t.turnId}`, 7, fmtTokens(t.write), 'yellow')}
                {cell(`f:${t.turnId}`, 6, fmtTokens(t.fresh), 'cyan')}
                {cell(`h:${t.turnId}`, 5, `${hit}%`, percentTone(100 - hit))}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}

function statusLine(view: View, now: number): string {
  const parts: string[] = []
  const c = view.context
  if (c?.tokens !== undefined) parts.push(`ctx ${c.percent ?? Math.round((c.tokens / c.window) * 100)}%`)
  const left = remainingMs(view.last, view.ttl, now)
  parts.push(left > 0 ? `cache ${fmtClock(left)}` : 'cache --')
  if (view.keeper.dueAt !== undefined) parts.push(`${view.keeper.next} ${fmtClock(view.keeper.dueAt - now)}`)
  return parts.join(' · ')
}
