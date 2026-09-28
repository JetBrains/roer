import { describe, expect, test } from 'claude-code/testing'
import { apply, contextOf, EMPTY, getAt, own, setAt } from '../hooks/a2ui'

const PANE = {
  component: 'Pane',
  requestId: 'roer-ui',
  props: { title: 'Roer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const FORM = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'bug',
    sendDataModel: true,
    dataModel: { title: '', urgent: false, area: ['ui'], steps: [{ text: 'open it' }, { text: 'click' }] },
    components: [
      { id: 'root', component: 'Card', child: 'col' },
      { id: 'col', component: 'Column', children: ['heading', 'title', 'urgent', 'area', 'steps', 'file'] },
      { id: 'heading', component: 'Text', text: 'File a bug' },
      { id: 'title', component: 'TextField', label: 'Title', value: { path: '/title' } },
      { id: 'urgent', component: 'CheckBox', label: 'Urgent', value: { path: '/urgent' } },
      {
        id: 'area',
        component: 'ChoicePicker',
        label: 'Area',
        variant: 'mutuallyExclusive',
        options: [{ label: 'UI', value: 'ui' }, { label: 'CLI', value: 'cli' }],
        value: { path: '/area' },
      },
      { id: 'steps', component: 'List', children: { componentId: 'step', path: '/steps' } },
      { id: 'step', component: 'Text', text: { path: 'text' } },
      { id: 'file', component: 'Button', child: 'file-label', variant: 'primary', action: { event: { name: 'file', context: { title: { path: '/title' } } } } },
      { id: 'file-label', component: 'Text', text: 'File it' },
    ],
  },
}

describe('roer-ui', () => {
  test('the pane says how to start before anything is shown', async $ => {
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Nothing to show yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('show draws a surface, and inputs write back to its data model', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const shown = await $.tool.call({ tool: 'mcp__roer-ui__show', messages: [FORM] })
    expect(shown.deny).toBeUndefined()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'roer-ui', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: 'File a bug' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'click' })).toBeDefined()
      await ui.input({ key: 'bug.title', text: 'crash on start' })
      // The data model is the surface's, not the drawing's: each press flips it.
      const was = (await ui.find({ key: 'bug.urgent' }))?.text ?? ''
      await ui.press({ key: 'bug.urgent' })
      expect((await ui.find({ key: 'bug.urgent' }))?.text).toBe(was.startsWith('[x]') ? '[ ] Urgent' : '[x] Urgent')
      expect((await ui.find({ key: 'bug.title' }))?.props).toEqual(expect.objectContaining({ value: 'crash on start' }))
      await ui.select({ key: 'bug.area', value: 'cli' })
      await ui.unmount()
    }
  })

  test('a malformed message is refused and nothing changes', async $ => {
    const shown = await $.tool.call({ tool: 'mcp__roer-ui__show', messages: [{ version: 'v0.9', createSurface: {} }] })
    expect(shown.deny).toContain('message 1')
  })

  test('mobile, which draws no fields, still shows the values', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: 'mcp__roer-ui__show', messages: [FORM] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'mobile', ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Title:/ })).toBeDefined()
    await ui.unmount()
  })

  test('a press reaches the model as a prompt carrying the action', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.tool.call({ tool: 'mcp__roer-ui__show', messages: [FORM] })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.input({ key: 'bug.title', text: 'crash on start' })
    await ui.press({ key: 'bug.file' })
    const [prompt = ''] = sent
    expect(prompt.startsWith('[roer-ui] The person pressed "File it" in the bug UI.')).toBe(true)
    const [, action = '{}', data = ''] = prompt.split('\n')
    expect(JSON.parse(action).action).toEqual(
      expect.objectContaining({ name: 'file', surfaceId: 'bug', sourceComponentId: 'file', context: { title: 'crash on start' } }),
    )
    expect(data.startsWith('dataModel: ')).toBe(true)
    await ui.unmount()
  })

  test('a component loop draws once, as a placeholder where it closes', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    // Each Row names the other twice: cut only by depth, this would draw
    // exponentially many nodes before it stopped.
    await $.tool.call({
      tool: 'mcp__roer-ui__show',
      messages: [{ version: 'v1.0', createSurface: { surfaceId: 's', components: [
        { id: 'root', component: 'Row', children: ['a', 'a'] },
        { id: 'a', component: 'Row', children: ['root', 'root', 'leaf'] },
        { id: 'leaf', component: 'Text', text: 'leaf' },
      ] } }],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: '(cycle at root)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'leaf' })).toBeDefined()
    await ui.unmount()
  })

  test('Tabs show one tab at a time, and a press switches', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({
      tool: 'mcp__roer-ui__show',
      messages: [{ version: 'v1.0', createSurface: { surfaceId: 's', components: [
        { id: 'root', component: 'Tabs', tabs: [{ title: 'One', child: 'first' }, { title: 'Two', child: 'second' }] },
        { id: 'first', component: 'Text', text: 'first tab' },
        { id: 'second', component: 'Text', text: 'second tab' },
      ] } }],
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'roer-ui', surface, ...PANE })
      expect((await ui.find({ key: 's.root.tab0' }))?.text).toBe('[One]')
      expect(await ui.find({ type: 'Text', text: 'first tab' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'second tab' })).toBeUndefined()
      await ui.press({ key: 's.root.tab1' })
      expect((await ui.find({ key: 's.root.tab1' }))?.text).toBe('[Two]')
      expect(await ui.find({ type: 'Text', text: 'second tab' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'first tab' })).toBeUndefined()
      await ui.press({ key: 's.root.tab0' })
      await ui.unmount()
    }
  })

  test('a userMessage rides in the action as well as the prompt', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const button = { id: 'go', component: 'Button', child: 'go-label', action: { event: { name: 'go', userMessage: 'Ship it' } } }
    await $.tool.call({
      tool: 'mcp__roer-ui__show',
      messages: [{ version: 'v1.0', createSurface: { surfaceId: 's', components: [
        { id: 'root', component: 'Column', children: ['go'] }, button, { id: 'go-label', component: 'Text', text: 'Go' },
      ] } }],
    })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 's.go' })
    const [prompt = ''] = sent
    const [said = '', action = '{}'] = prompt.split('\n')
    expect(said).toBe('[roer-ui] Ship it')
    expect(JSON.parse(action).action.userMessage).toBe('Ship it')
    await ui.unmount()
  })
})

describe('the reducer', () => {
  const surface = (dataModel: Record<string, unknown> = {}) =>
    apply(EMPTY, { version: 'v1.0', createSurface: { surfaceId: 's', dataModel } })

  test('refuses a message with two bodies, or a malformed component list', () => {
    expect(typeof apply(EMPTY, { version: 'v1.0', createSurface: { surfaceId: 's' }, deleteSurface: { surfaceId: 's' } })).toBe('string')
    for (const components of [{}, [null], [{ id: 'a' }], [{ component: 'Text' }]]) {
      expect(typeof apply(EMPTY, { version: 'v1.0', createSurface: { surfaceId: 's', components } })).toBe('string')
    }
    const made = surface()
    if (typeof made === 'string') throw new Error(made)
    expect(typeof apply(made, { version: 'v1.0', updateComponents: { surfaceId: 's', components: [null] } })).toBe('string')
    expect(typeof apply(made, { version: 'v1.0', updateComponents: { surfaceId: 's' } })).toBe('string')
  })

  test('refuses an updateDataModel without a value, and deletes on null', () => {
    const made = surface({ title: 'x', keep: 1, list: ['a', 'b', 'c'] })
    if (typeof made === 'string') throw new Error(made)
    expect(typeof apply(made, { version: 'v1.0', updateDataModel: { surfaceId: 's', path: '/title' } })).toBe('string')
    const cleared = apply(made, { version: 'v1.0', updateDataModel: { surfaceId: 's', path: '/title', value: null } })
    if (typeof cleared === 'string') throw new Error(cleared)
    expect(cleared.bySurface.s?.dataModel).toEqual({ keep: 1, list: ['a', 'b', 'c'] })
    expect(setAt({ list: ['a', 'b', 'c'] }, '/list/1', null)).toEqual({ list: ['a', 'c'] })
  })

  test('a relative pointer keeps its first character', () => {
    expect(setAt({}, 'title', 'x')).toEqual({ title: 'x' })
    expect(getAt({ title: 'x' }, 'title')).toBe('x')
  })

  test('a component id is data, whatever it is called', () => {
    const made = apply(EMPTY, JSON.parse(`{"version": "v1.0", "createSurface": {"surfaceId": "s", "components": [
      {"id": "root", "component": "Column", "children": ["__proto__"]},
      {"id": "__proto__", "component": "Text", "text": "odd id"}
    ]}}`))
    if (typeof made === 'string') throw new Error(made)
    const components = made.bySurface.s?.components ?? {}
    expect(Object.getPrototypeOf(components)).toBe(Object.prototype)
    expect(own(components, '__proto__')?.text).toBe('odd id')
    expect(own(components, 'toString')).toBeUndefined()
  })

  test('an action context keeps every key as data, __proto__ included', () => {
    // Parsed, not written as a literal: a literal `__proto__:` sets the prototype.
    const context = JSON.parse('{"__proto__": {"path": "/who"}, "plain": "too"}')
    const out = contextOf(context, { who: 'me' }, '')
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"__proto__": "me", "plain": "too"}'))
  })

  test('never writes or reads through the prototype', () => {
    for (const path of ['/__proto__/polluted', '/constructor/prototype/polluted', '/a/__proto__']) {
      const out = setAt({ a: {} }, path, true)
      expect(out).toEqual({ a: {} })
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(getAt({}, '/constructor')).toBeUndefined()
    expect(getAt({}, '/toString')).toBeUndefined()
  })
})
