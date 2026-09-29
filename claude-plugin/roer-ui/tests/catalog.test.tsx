import { describe, expect, test } from 'claude-code/testing'
import { resolve } from '../hooks/a2ui'
import { progressValue, shownValue, statusTone } from '../hooks/workItem'

const PANE = {
  component: 'Pane',
  requestId: 'roer-ui',
  props: { title: 'Roer', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const TOOL = 'mcp__roer-ui__show'
const create = (components: unknown[], dataModel: Record<string, unknown> = {}, sendDataModel = false) => ({
  version: 'v1.0',
  createSurface: { surfaceId: 's', components, dataModel, sendDataModel },
})

const PATCH = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
 export { a }
`

/** Every component in roer:catalog/1, at least once. */
const EVERYTHING = [
  { id: 'root', component: 'Column', children: ['grid', 'row', 'list', 'card', 'tabs', 'modal', 'exp', 'div', 'vdiv', 'arrow', 'varrow', 'txt', 'icon', 'img', 'vid', 'aud', 'btn', 'field', 'check', 'pick', 'slider', 'when', 'diff', 'tile', 'status', 'item', 'reqs', 'finds', 'decs', 'srcs', 'talk'] },
  { id: 'grid', component: 'Grid', columns: 2, children: ['g1', 'g2', 'g3'] },
  { id: 'g1', component: 'Text', text: 'grid one' },
  { id: 'g2', component: 'Text', text: 'grid two' },
  { id: 'g3', component: 'Text', text: 'grid three' },
  { id: 'row', component: 'Row', align: 'center', children: ['r1'] },
  { id: 'r1', component: 'Text', text: 'in a row', weight: 1 },
  { id: 'list', component: 'List', children: { componentId: 'n', path: '/names' } },
  { id: 'n', component: 'Text', text: { path: 'name' } },
  { id: 'card', component: 'Card', child: 'c1' },
  { id: 'c1', component: 'Text', text: 'in a card' },
  { id: 'tabs', component: 'Tabs', tabs: [{ title: 'A', child: 't1' }] },
  { id: 't1', component: 'Text', text: 'tab body' },
  { id: 'modal', component: 'Modal', trigger: 'mt', content: 'mc' },
  { id: 'mt', component: 'Text', text: 'modal trigger' },
  { id: 'mc', component: 'Text', text: 'modal content' },
  { id: 'exp', component: 'Expandable', title: 'More', child: 'ec' },
  { id: 'ec', component: 'Text', text: 'expanded content' },
  { id: 'div', component: 'Divider' },
  { id: 'vdiv', component: 'Divider', axis: 'vertical' },
  { id: 'arrow', component: 'Arrow', label: 'then' },
  { id: 'varrow', component: 'Arrow', direction: 'vertical' },
  { id: 'txt', component: 'Text', text: 'caption text', variant: 'caption' },
  { id: 'icon', component: 'Icon', name: 'star' },
  { id: 'img', component: 'Image', url: 'https://example.com/a.png', description: 'a chart' },
  { id: 'vid', component: 'Video', url: 'https://example.com/a.mp4' },
  { id: 'aud', component: 'AudioPlayer', url: 'https://example.com/a.mp3', description: 'standup' },
  { id: 'btn', component: 'Button', child: 'bl', action: { event: { name: 'go' } } },
  { id: 'bl', component: 'Text', text: 'Go' },
  { id: 'field', component: 'TextField', label: 'Name', value: { path: '/name' } },
  { id: 'check', component: 'CheckBox', label: 'Done', value: { path: '/done' } },
  { id: 'pick', component: 'ChoicePicker', options: [{ label: 'X', value: 'x' }], value: { path: '/picked' }, displayStyle: 'chips' },
  { id: 'slider', component: 'Slider', max: 10, value: { path: '/level' } },
  { id: 'when', component: 'DateTimeInput', enableDate: true, value: { path: '/day' }, label: 'Day' },
  { id: 'diff', component: 'DiffView', diff: PATCH, title: 'The change' },
  { id: 'tile', component: 'StatTile', label: 'running jobs', value: 12, trend: { delta: 3, direction: 'up' } },
  { id: 'status', component: 'StatusCard', title: 'Deploy', status: 'running', progress: 40 },
  { id: 'item', component: 'WorkItem', title: 'Fix it', source: 'github', key: '#21', status: 'open' },
  { id: 'reqs', component: 'Requirements', items: [{ id: 'r', text: 'works', met: false }] },
  { id: 'finds', component: 'Findings', items: [{ id: 'f', severity: 'warn', text: 'slow' }] },
  { id: 'decs', component: 'Decisions', items: [{ id: 'd', question: 'Which?', options: [{ label: 'This', value: 'this' }] }] },
  { id: 'srcs', component: 'Sources', items: [{ kind: 'doc', label: 'spec', url: 'https://example.com/spec' }] },
  { id: 'talk', component: 'Comments', items: [{ id: 'k', author: 'ana', text: 'looks good', at: '2h ago' }] },
]

describe('the whole catalog', () => {
  test('every component draws on every surface, none as a placeholder', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const shown = await $.tool.call({ tool: TOOL, messages: [create(EVERYTHING, { names: [{ name: 'ana' }, { name: 'bo' }], level: 4 })] })
    expect(shown.deny).toBeUndefined()
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'roer-ui', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /not in roer:catalog|not drawn|missing|cycle/ })).toBeUndefined()
      for (const seen of ['grid three', 'in a row', 'bo', 'in a card', 'tab body', 'modal trigger', 'caption text', 'star', 'looks good', 'running jobs', 'Deploy', 'Fix it', 'The change', 'Which?', 'slow']) {
        expect(await ui.find({ text: seen })).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('media is named and linked, since a terminal plays none of it', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, messages: [create(EVERYTHING, { names: [] })] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Link', text: '[image: a chart]' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '▶ video' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '♪ standup' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '── then ──▶' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '│' })).toBeDefined()
    await ui.unmount()
  })
})

describe('inputs', () => {
  test('a Slider steps within its range and writes a number', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, messages: [create([{ id: 'root', component: 'Slider', min: 0, max: 10, steps: 5, value: { path: '/level' } }], { level: 8 })] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    const shows = async (n: string) => expect(await ui.find({ type: 'Text', text: n })).toBeDefined()
    await shows('8')
    await ui.press({ key: 's.root.more' })
    await shows('10')
    await ui.press({ key: 's.root.more' })
    await shows('10')
    await ui.press({ key: 's.root.less' })
    await shows('8')
    await ui.unmount()
  })

  test('a number TextField writes a number, and an obscured one never shows its value', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.tool.call({
      tool: TOOL,
      messages: [create([
        { id: 'root', component: 'Column', children: ['n', 'p', 'go'] },
        { id: 'n', component: 'TextField', label: 'Count', variant: 'number', value: { path: '/count' } },
        { id: 'p', component: 'TextField', label: 'Secret', variant: 'obscured', value: { path: '/secret' } },
        { id: 'go', component: 'Button', child: 'gl', action: { event: { name: 'go' } } },
        { id: 'gl', component: 'Text', text: 'Go' },
      ], { count: 1, secret: 'hunter2' }, true)],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    const secret = (await ui.find({ key: 's.p' }))?.props as { value?: string; placeholder?: string } | undefined
    expect(secret?.value).toBeUndefined()
    expect(secret?.placeholder).toBe('•••••••')
    await ui.input({ key: 's.n', text: '42' })
    await ui.press({ key: 's.go' })
    const data = (sent[0] ?? '').split('\n').find(line => line.startsWith('dataModel: ')) ?? ''
    expect(JSON.parse(data.slice('dataModel: '.length)).count).toBe(42)
    await ui.unmount()
  })

  test('chips toggle, a filter narrows the options, and a single choice pressed again clears', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({
      tool: TOOL,
      messages: [create([
        { id: 'root', component: 'ChoicePicker', displayStyle: 'chips', filterable: true, value: { path: '/picked' },
          options: [{ label: 'Apple', value: 'a' }, { label: 'Banana', value: 'b' }] },
      ], { picked: [] })],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 's.root.a' })
    expect((await ui.find({ key: 's.root.a' }))?.text).toBe('[Apple]')
    await ui.press({ key: 's.root.a' })
    expect((await ui.find({ key: 's.root.a' }))?.text).toBe(' Apple ')
    await ui.input({ key: 's.root.filter', text: 'ban' })
    expect(await ui.find({ key: 's.root.a' })).toBeUndefined()
    expect(await ui.find({ key: 's.root.b' })).toBeDefined()
    await ui.unmount()
  })

  test('a DateTimeInput offers the format its flags ask for', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({
      tool: TOOL,
      messages: [create([
        { id: 'root', component: 'Column', children: ['d', 't', 'both'] },
        { id: 'd', component: 'DateTimeInput', enableDate: true, value: { path: '/d' }, label: 'Day' },
        { id: 't', component: 'DateTimeInput', enableTime: true, value: { path: '/t' }, label: 'Time' },
        { id: 'both', component: 'DateTimeInput', value: { path: '/b' }, label: 'When' },
      ])],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect((await ui.find({ key: 's.d' }))?.props).toEqual(expect.objectContaining({ placeholder: 'YYYY-MM-DD' }))
    expect((await ui.find({ key: 's.t' }))?.props).toEqual(expect.objectContaining({ placeholder: 'HH:MM' }))
    expect((await ui.find({ key: 's.both' }))?.props).toEqual(expect.objectContaining({ placeholder: 'YYYY-MM-DDTHH:MM' }))
    await ui.input({ key: 's.d', text: '2026-09-28' })
    expect((await ui.find({ key: 's.d' }))?.props).toEqual(expect.objectContaining({ value: '2026-09-28' }))
    await ui.unmount()
  })
})

describe('pane state', () => {
  test('an Expandable and a Modal open and close, and a new surface starts them over', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const components = [
      { id: 'root', component: 'Column', children: ['exp', 'modal'] },
      { id: 'exp', component: 'Expandable', title: 'More', child: 'ec' },
      { id: 'ec', component: 'Text', text: 'expanded content' },
      { id: 'modal', component: 'Modal', trigger: 'mt', content: 'mc' },
      { id: 'mt', component: 'Text', text: 'trigger' },
      { id: 'mc', component: 'Text', text: 'modal content' },
    ]
    await $.tool.call({ tool: TOOL, messages: [create(components)] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: 'expanded content' })).toBeUndefined()
    await ui.press({ key: 's.exp.toggle' })
    expect(await ui.find({ text: 'expanded content' })).toBeDefined()
    expect(await ui.find({ text: 'modal content' })).toBeUndefined()
    await ui.press({ key: 's.modal.open' })
    expect(await ui.find({ text: 'modal content' })).toBeDefined()
    await ui.press({ key: 's.modal.open' })
    expect(await ui.find({ text: 'modal content' })).toBeUndefined()
    await ui.unmount()

    await $.tool.call({ tool: TOOL, messages: [create(components)] })
    const again = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await again.find({ text: 'expanded content' })).toBeUndefined()
    await again.unmount()
  })
})

describe('dashboards', () => {
  test('a StatusCard draws its progress, and no bar for a value that is not one', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({
      tool: TOOL,
      messages: [create([
        { id: 'root', component: 'List', children: { componentId: 'run', path: '/runs' } },
        { id: 'run', component: 'StatusCard', title: { path: 'name' }, status: { path: 'status' }, progress: { path: 'progress' } },
      ], { runs: [{ name: 'build', status: 'running', progress: 50 }, { name: 'lint', status: 'failed', progress: false }] })],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: `${'█'.repeat(10)}${'░'.repeat(10)} 50%` })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /%$/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: 'failed' })).toBeDefined()
    await ui.unmount()
  })

  test('a DiffView draws its notes under the file they are about', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({
      tool: TOOL,
      messages: [create([
        { id: 'root', component: 'Column', children: ['d', 'e'] },
        { id: 'd', component: 'DiffView', diff: PATCH, notes: [{ path: 'app.ts', line: 1, text: 'why 2?' }] },
        { id: 'e', component: 'DiffView', diff: '', emptyText: 'Nothing changed.' },
      ])],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  app.ts:1  why 2?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Nothing changed.' })).toBeDefined()
    await ui.unmount()
  })
})

describe('a work item in detail', () => {
  const ITEM = (overrides: Record<string, unknown> = {}) => ({
    key: 'RO-12',
    title: 'Speed up start',
    status: 'working',
    goal: 'Start in under a second',
    requirements: [{ id: 'r1', text: 'Measured', met: false }],
    decisions: [{ id: 'd1', question: 'Cache where?', options: [{ label: 'Disk', value: 'disk' }, { label: 'Memory', value: 'mem' }] }],
    findings: [{ id: 'f1', severity: 'error', text: 'Leaks a handle', at: { changeId: 'c1', path: 'app.ts', line: 1 } }],
    sources: [{ kind: 'ticket', label: 'RO-12', url: 'https://example.com/RO-12' }, { kind: 'file', label: 'notes', path: 'docs/notes.md' }],
    comments: [{ id: 'k1', author: 'ana', text: 'Please measure first' }],
    changes: [{ id: 'c1', title: 'Lazy load', patch: PATCH }],
    ...overrides,
  })
  const DETAIL = [
    { id: 'root', component: 'WorkItem', variant: 'detail', key: { path: '/item/key' }, title: { path: '/item/title' },
      status: { path: '/item/status' }, goal: { path: '/item/goal' }, requirements: { path: '/item/requirements' },
      decisions: { path: '/item/decisions' }, findings: { path: '/item/findings' }, sources: { path: '/item/sources' },
      comments: { path: '/item/comments' }, changes: { path: '/item/changes' } },
  ]

  test('draws every section, and what the person does reaches the model with the item', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.tool.call({ tool: TOOL, messages: [create(DETAIL, { item: ITEM() })] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    const missing: string[] = []
    for (const seen of ['Start in under a second', 'Needs you · 2', 'Requirements · 0 of 1', 'Sources', 'Comments', 'Changes', 'Please measure first', 'ticket  RO-12', 'file  notes  docs/notes.md', '  app.ts:1  error: Leaks a handle']) {
      if ((await ui.find({ text: seen })) === undefined) missing.push(seen)
    }
    // The only change is open, with the open finding drawn at its line.
    expect(missing).toEqual([])

    await ui.press({ key: 's.root.req.r1' })
    await ui.press({ key: 's.root.decision.d1.disk' })
    await ui.press({ key: 's.root.finding.f1.resolve' })
    const actions = sent.map(prompt => JSON.parse(prompt.split('\n')[1] ?? '{}').action)
    expect(actions.map(a => [a.name, a.context])).toEqual([
      ['toggleRequirement', { workItem: 'RO-12', id: 'r1', met: true }],
      ['answerDecision', { workItem: 'RO-12', id: 'd1', answer: 'disk' }],
      ['settleFinding', { workItem: 'RO-12', id: 'f1', state: 'resolved' }],
    ])
    // Shown at once, though not written to the data model.
    expect((await ui.find({ key: 's.root.req.r1' }))?.text).toBe('[x] Measured')
    expect(await ui.find({ text: 'Answered: Disk' })).toBeDefined()
    expect(await ui.find({ text: 'Needs you · nothing open' })).toBeDefined()
    await ui.unmount()
  })

  test('a second answer or a reopen sticks, compared with the agent\'s value, not the first', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    await $.tool.call({ tool: TOOL, messages: [create(DETAIL, { item: ITEM() })] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 's.root.decision.d1.disk' })
    await ui.press({ key: 's.root.decision.d1.change' })
    await ui.press({ key: 's.root.decision.d1.mem' })
    expect(await ui.find({ text: 'Answered: Memory' })).toBeDefined()
    await ui.press({ key: 's.root.finding.f1.resolve' })
    await ui.press({ key: 's.root.finding.f1.reopen' })
    expect(await ui.find({ key: 's.root.finding.f1.resolve' })).toBeDefined()
    await ui.unmount()
  })

  test("the person's value survives the agent resending the old one, and yields to a new one", async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    await $.tool.call({ tool: TOOL, messages: [create(DETAIL, { item: ITEM() })] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 's.root.req.r1' })
    await ui.unmount()

    const resend = (met: boolean) => ({ version: 'v1.0', updateDataModel: { surfaceId: 's', path: '/item/requirements', value: [{ id: 'r1', text: 'Measured', met }] } })
    await $.tool.call({ tool: TOOL, messages: [resend(false)] })
    const same = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect((await same.find({ key: 's.root.req.r1' }))?.text).toBe('[x] Measured')
    await same.unmount()

    await $.tool.call({ tool: TOOL, messages: [resend(true)] })
    const agreed = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect((await agreed.find({ key: 's.root.req.r1' }))?.text).toBe('[x] Measured')
    await agreed.press({ key: 's.root.req.r1' })
    expect((await agreed.find({ key: 's.root.req.r1' }))?.text).toBe('[ ] Measured')
    await agreed.unmount()
  })
})

describe('the rules shared with Roer', () => {
  test('@index is the template item position, plus an offset', () => {
    expect(resolve({ call: '@index' }, {}, '/rows/2')).toBe(2)
    expect(resolve({ call: '@index', args: { offset: 1 } }, {}, '/rows/2')).toBe(3)
    expect(resolve({ call: '@index' }, {}, '')).toBeUndefined()
    expect(resolve({ call: 'formatString' }, {}, '/rows/2')).toBeUndefined()
  })

  test('statuses read by meaning, progress only from numbers', () => {
    expect(['closed', 'Fixed', 'done'].map(statusTone)).toEqual(['done', 'done', 'done'])
    expect(statusTone('In Progress')).toBe('doing')
    expect(statusTone('error')).toBe('failed')
    expect([50, '75', 140, false, null, ' ', 'x'].map(progressValue)).toEqual([50, 75, 100, undefined, undefined, undefined, undefined])
  })

  test("a person's value is shown only over the value it replaced", () => {
    expect(shownValue({ base: false, value: true }, false)).toBe(true)
    expect(shownValue({ base: false, value: true }, true)).toBe(true)
    expect(shownValue({ base: 'a', value: 'b' }, 'c')).toBe('c')
    expect(shownValue(undefined, 'c')).toBe('c')
  })
})
