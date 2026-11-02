import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const TOOL = 'mcp__roer-ui__show'
const PANE = {
  component: 'Pane',
  requestId: 'roer-ui',
  props: { title: 'Roer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SURFACE = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 's',
    components: [{ id: 'root', component: 'Text', text: { path: '/count' } }],
  },
}
const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** A session whose `count` command prints one more every time, `{ a: { count } }`. */
function counting(on: On, decision: () => 'allow' | 'ask' | 'deny' = () => 'allow') {
  let count = 0
  const runs: string[][] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'roer' } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.check', () => ({ decision: decision() }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'printenv') return out('/home/me\n')
    count += 1
    return out(JSON.stringify({ a: { count } }))
  })
  return runs
}

const shownCount = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
  const found = (await ui.find({ type: 'Text', text: /^\d+$/ }))?.text
  await ui.unmount()
  return found
}

const LOAD = { version: 'v1.0', loadData: { surfaceId: 's', path: '/count', run: ['count'], as: 'json', pick: '/a/count', every: 2 } }

describe('live loads', () => {
  test('a live load runs again on its own and writes only what changed', async ($, on) => {
    const clock = mock.clock(on)
    counting(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const shown = await $.tool.call({ tool: TOOL, messages: [SURFACE, LOAD] })
    expect(String(shown.result)).toMatch(/Live: `count` every 2s/)
    expect(await shownCount($)).toBe('1')

    await clock.advance(1000)
    expect(await shownCount($)).toBe('1')
    await clock.advance(1500)
    expect(await shownCount($)).toBe('2')
  })

  test('stops refreshing once the permissions would ask, and never opens the dialog', async ($, on) => {
    const clock = mock.clock(on)
    let decision: 'allow' | 'ask' = 'allow'
    const runs = counting(on, () => decision)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, messages: [SURFACE, LOAD] })
    decision = 'ask'
    const before = runs.length
    await clock.advance(5000)
    expect(runs.length).toBe(before)
    expect(await shownCount($)).toBe('1')
  })

  test('stops when its surface is gone', async ($, on) => {
    const clock = mock.clock(on)
    const runs = counting(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, messages: [SURFACE, LOAD] })
    await $.tool.call({ tool: TOOL, messages: [{ version: 'v1.0', deleteSurface: { surfaceId: 's' } }] })
    const before = runs.length
    await clock.advance(10000)
    expect(runs.length).toBe(before)
  })

  test('refuses an every out of range, and a pick on text', async ($, on) => {
    counting(on)
    const fast = await $.tool.call({ tool: TOOL, messages: [SURFACE, { ...LOAD, loadData: { ...LOAD.loadData, every: 0.1 } }] })
    expect(fast.deny).toMatch(/every is seconds, from 1 to 3600/)
    const text = await $.tool.call({ tool: TOOL, messages: [SURFACE, { ...LOAD, loadData: { ...LOAD.loadData, as: 'text' } }] })
    expect(text.deny).toMatch(/picks from JSON/)
  })
})
