// Run with: claude plugin test plugins/cache-keeper
// The engine beneath the plugin is mocked: the clock, the model, compaction
// and the sleep-hold child, so an idle hour passes in milliseconds.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = 1_000_000_000_000
const MINUTE = 60_000
// A test hook cannot outlive its 10 s budget, so a held child is tried apart, briefly
const OPTIONS = { options: { ttl: '1h', marginMinutes: 5, keepAlives: 1, inhibitSleep: false }, timeoutMs: 120_000 }
const WITH_SLEEP = { options: { ttl: '1h', marginMinutes: 5, keepAlives: 1 }, timeoutMs: 30_000 }

function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  mock.store(on)
  const seen = { forks: [] as number[], compacts: 0, spawned: [] as string[][], killed: 0 }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('session.usage', async () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [] } }))
  on('settings.read', async () => ({ value: {} }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('process.spawn', async function* ($, e, next) {
    seen.spawned.push([...e.argv])
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    seen.killed += 1
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  on('model.fork', async () => {
    seen.forks.push(clock.now())
    return {
      value: {
        isAnswered: true as const,
        text: '.',
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('session.compact', async () => {
    seen.compacts += 1
    return { messages: [], tokensBefore: 50_000, tokensAfter: 5_000 }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000 },
    }
  })
  on('turn.complete', async () => ({ text: 'done' }))
  return { clock, seen }
}

async function oneTurn($: Engine, turnId: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // no chunks
  }
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

test('an idle 1h session is kept alive, then compacted', OPTIONS, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  await oneTurn($, 't1')

  await clock.advance(54 * MINUTE)
  expect(seen.forks).toHaveLength(0)
  await clock.advance(MINUTE + 1000)
  expect(seen.forks).toHaveLength(1)
  expect(seen.compacts).toBe(0)

  await clock.advance(55 * MINUTE)
  expect(seen.compacts).toBe(1)
  expect(seen.forks).toHaveLength(1)
  expect(seen.spawned).toHaveLength(0)
})

test('the person coming back cancels the keeper', OPTIONS, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  await oneTurn($, 't1')
  await clock.advance(30 * MINUTE)
  await $.prompt.submit({ text: 'back', origin: { kind: 'user' } } as never)
  await clock.advance(60 * MINUTE)
  expect(seen.forks).toHaveLength(0)
  expect(seen.compacts).toBe(0)
})

test('sleep is held while the keeper waits and let go when the person is back', WITH_SLEEP, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  expect(seen.spawned).toHaveLength(0)
  await oneTurn($, 't1')
  await clock.advance(1000)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.[0]).toBe('systemd-inhibit')
  await $.prompt.submit({ text: 'back', origin: { kind: 'user' } } as never)
  await clock.advance(1000)
  expect(seen.killed).toBe(1)
  expect(seen.spawned).toHaveLength(1)
})

test('a cache that lapsed while away is left alone', OPTIONS, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  await oneTurn($, 't1')
  // Paused, the keeper lets the deadline pass, as a sleeping machine would
  await $.command.run({ command: 'ttl', args: 'pause' } as never)
  await clock.advance(2 * 60 * MINUTE)
  await $.command.run({ command: 'ttl', args: 'resume' } as never)
  await clock.advance(2000)
  expect(seen.forks).toHaveLength(0)
  expect(seen.compacts).toBe(0)
})

test('the band and the pane draw on the terminal and the desktop', OPTIONS, async ($, on) => {
  const { clock } = world(on)
  // The engine's own band is empty beneath the plugin
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({}))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  await oneTurn($, 't1')
  await $.session.measure({
    context: { tokens: 116_000, window: 200_000, percent: 58 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23 }, { kind: 'seven_day', percentUsed: 41 }],
    changed: ['context', 'rateLimits'],
  })
  await clock.advance(1000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'cache-keeper',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: '58%' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /5h 23%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /keep-alive \d+:\d\d → compact / })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: 'cache-keeper',
      surface,
      component: 'Pane',
      requestId: 'cache-keeper',
      props: { title: 'cache-keeper', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: /compacts at|unknown/ })).toBeDefined()
    await pane.press({ key: 'pause' })
    await clock.advance(1000)
    expect(await pane.find({ type: 'Text', text: 'paused' })).toBeDefined()
    await pane.press({ key: 'pause' })
    await clock.advance(1000)
    await pane.unmount()
  }
})
