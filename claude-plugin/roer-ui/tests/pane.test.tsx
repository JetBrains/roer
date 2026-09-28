import { describe, expect, test } from 'claude-code/testing'

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
})
