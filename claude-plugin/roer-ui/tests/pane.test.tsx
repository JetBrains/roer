import { describe, expect, test } from 'claude-code/testing'
import { apply, contextOf, EMPTY, getAt, own, setAt } from '../hooks/a2ui'
import { readLoad, readLoadData, readLocal, shellCommand } from '../hooks/local'

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

describe('without a turn', () => {
  const TOOL = 'mcp__roer-ui__show'
  const ran = (ran: string[][], out: (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string }) =>
    (_$: unknown, e: { argv: readonly string[] }) => {
      ran.push([...e.argv])
      const { exitCode = 0, stdout = '', stderr = '' } = out(e.argv)
      return { value: { exitCode, stdout, stderr } }
    }

  // A PR list whose rows come from gh, and a hidden diff view each row opens.
  const BROWSER = [
    { version: 'v1.0', createSurface: { surfaceId: 'prs', components: [
      { id: 'root', component: 'List', children: { componentId: 'row', path: '/prs' } },
      { id: 'row', component: 'Button', child: 'row-label', action: { local: {
        open: 'diff',
        load: [
          { path: '/title', value: { path: 'title' } },
          { path: '/diff', run: ['gh', 'pr', 'diff', { path: 'number' }] },
        ],
      } } },
      { id: 'row-label', component: 'Text', text: { path: 'title' } },
    ] } },
    { version: 'v1.0', loadData: { surfaceId: 'prs', path: '/prs', run: ['gh', 'pr', 'list', '--json', 'number,title'], as: 'json' } },
    { version: 'v1.0', createSurface: { surfaceId: 'diff', hidden: true, components: [
      { id: 'root', component: 'Column', children: ['back', 'title', 'view'] },
      { id: 'back', component: 'Button', child: 'back-label', action: { local: { open: 'prs' } } },
      { id: 'back-label', component: 'Text', text: 'Back' },
      { id: 'title', component: 'Text', text: { path: '/title' } },
      { id: 'view', component: 'DiffView', diff: { path: '/diff' } },
    ] } },
  ]
  const allowAll = (on: (event: 'tool.check', hook: () => { decision: 'allow' }) => void) => on('tool.check', () => ({ decision: 'allow' }))
  const LIST = JSON.stringify([{ number: 36, title: 'Add roer-ui' }, { number: 38, title: 'Landing 0.5' }])
  const DIFF = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old line\n+new line\n'

  test('loadData fills a path from a command, and a hidden surface is not drawn', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    allowAll(on)
    const argvs: string[][] = []
    on('process.run', ran(argvs, () => ({ stdout: LIST })))
    const shown = await $.tool.call({ tool: TOOL, messages: BROWSER })
    expect(shown.deny).toBeUndefined()
    expect(argvs).toEqual([['gh', 'pr', 'list', '--json', 'number,title']])
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Button', text: 'Landing 0.5' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Back' })).toBeUndefined()
    await ui.unmount()
  })

  test('a failing command refuses the whole call, and a malformed one runs nothing', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    allowAll(on)
    const argvs: string[][] = []
    on('process.run', ran(argvs, () => ({ exitCode: 1, stderr: 'no pull requests found' })))
    const failed = await $.tool.call({ tool: TOOL, messages: BROWSER })
    expect(failed.deny).toContain('`gh pr list --json number,title` exited 1: no pull requests found')
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Nothing to show yet/ })).toBeDefined()
    await ui.unmount()
    argvs.length = 0
    const early = await $.tool.call({ tool: TOOL, messages: [BROWSER[1], BROWSER[0]] })
    expect(early.deny).toContain('names no surface on screen (prs)')
    expect(argvs).toEqual([])
  })

  test('a press opens the hidden surface and fills it with no prompt, and Back returns', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    allowAll(on)
    const argvs: string[][] = []
    on('process.run', ran(argvs, argv => ({ stdout: argv[2] === 'list' ? LIST : DIFF })))
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 'prs.row/prs/1' })
    expect(argvs.at(-1)).toEqual(['gh', 'pr', 'diff', '38'])
    expect(await ui.find({ type: 'Text', text: 'Landing 0.5' })).toBeDefined()
    // The file's path names its language, so the code is coloured as well as the diff.
    expect((await ui.find({ type: 'Code', text: /new line/ }))?.props).toEqual(expect.objectContaining({ path: 'x.ts', format: 'diff' }))
    expect(await ui.find({ type: 'Button', text: 'Add roer-ui' })).toBeUndefined()
    await ui.press({ key: 'diff.back' })
    expect(await ui.find({ type: 'Button', text: 'Add roer-ui' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Back' })).toBeUndefined()
    expect(sent).toEqual([])
    await ui.unmount()
  })

  test('a file\'s diff longer than one Code takes is drawn in pieces', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    allowAll(on)
    // Context, removed and added lines in turn, so each cut hunk needs its own counts.
    const lines = Array.from({ length: 900 }, (_, n) => `${[' ', '-', '+'][n % 3]}line ${n}`).join('\n')
    const BIG = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,600 +1,600 @@\n${lines}\n@@ -700,1 +700,1 @@\n-last old\n+last new\n`
    on('process.run', ran([], argv => ({ stdout: argv[2] === 'list' ? LIST : BIG })))
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 'prs.row/prs/0' })
    expect(await ui.find({ type: 'Code', text: /^ line 0$/m })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /^\+line 899$/m })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /\+last new$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a diff past what one drawing holds opens the files that fit, and the rest on request', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    allowAll(on)
    // Twelve files of about 11000 characters: past the engine's 100000 in all.
    const file = (n: number) => {
      const lines = Array.from({ length: 300 }, (_, k) => `+file ${n} line ${String(k).padStart(20, '.')}`)
      return `diff --git a/f${n}.ts b/f${n}.ts\n--- /dev/null\n+++ b/f${n}.ts\n@@ -0,0 +1,300 @@\n${lines.join('\n')}\n`
    }
    const HUGE = Array.from({ length: 12 }, (_, n) => file(n + 1)).join('')
    on('process.run', ran([], argv => ({ stdout: argv[2] === 'list' ? LIST : HUGE })))
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 'prs.row/prs/0' })
    expect(await ui.find({ type: 'Button', text: '▾ f1.ts  +300 −0' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /file 1 line/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '▸ f12.ts  +300 −0' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /file 12 line/ })).toBeUndefined()
    // Opened by the person, a file takes the room of one open by default.
    await ui.press({ key: 'diff.view.file.f12.ts' })
    expect(await ui.find({ type: 'Code', text: /file 12 line/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '▸ f5.ts  +300 −0' })).toBeDefined()
    // More opened than fits: the ones past the budget say so.
    for (const n of [6, 7, 8, 9, 10, 11]) await ui.press({ key: `diff.view.file.f${n}.ts` })
    expect(await ui.find({ type: 'Button', text: '▾ f11.ts  +300 −0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Too long to draw/ })).toBeDefined()
    await ui.unmount()
  })

  test('a load that fails says so on its surface', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    allowAll(on)
    on('process.run', ran([], argv => (argv[2] === 'list' ? { stdout: LIST } : { exitCode: 1, stderr: 'HTTP 404' })))
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 'prs.row/prs/0' })
    expect(await ui.find({ type: 'Text', text: '`gh pr diff 36` exited 1: HTTP 404' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No changes.' })).toBeDefined()
    await ui.unmount()
  })

  test('a command runs as the person\'s permissions say', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    // Listing is allowed; a diff asks; nothing else is run here.
    on('tool.check', (_$, e) => ({ decision: String((e.input as { command: string }).command).startsWith('gh pr list') ? 'allow' : 'ask' }))
    const direct: string[][] = []
    on('process.run', ran(direct, () => ({ stdout: LIST })))
    const asked: { command: string; consent?: string }[] = []
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      asked.push({ command: (e as unknown as { command: string }).command, consent: e.consent as string | undefined })
      return { result: { stdout: DIFF, stderr: '' } }
    })
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    expect(direct).toEqual([['gh', 'pr', 'list', '--json', 'number,title']])
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Button', text: 'Landing 0.5 (asks first)' })).toBeDefined()
    await ui.press({ key: 'prs.row/prs/1' })
    expect(asked).toEqual([{ command: 'gh pr diff 38', consent: 'The user pressed "Landing 0.5" in the Roer pane.' }])
    expect(direct).toHaveLength(1)
    expect(await ui.find({ type: 'Code', text: /new line/ })).toBeDefined()
    await ui.unmount()
  })

  test('output the Bash tool kept in a file is read whole', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('tool.check', (_$, e) => ({ decision: String((e.input as { command: string }).command).startsWith('gh pr list') ? 'allow' : 'ask' }))
    on('process.run', ran([], () => ({ stdout: LIST })))
    // Too long for the model: stdout is a preview, the whole of it on disk.
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: DIFF.slice(0, 40), stderr: '', persistedOutputPath: '/tmp/tool-results/diff.txt' },
    }))
    const reads: string[] = []
    on('fs.read', (_$, e) => {
      reads.push(e.path)
      return { value: DIFF }
    })
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    await ui.press({ key: 'prs.row/prs/1' })
    expect(reads).toEqual(['/tmp/tool-results/diff.txt'])
    expect(await ui.find({ type: 'Code', text: /new line/ })).toBeDefined()
    await ui.unmount()
  })

  test('a command the permissions deny is refused, when shown and when pressed', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('tool.check', (_$, e) =>
      String((e.input as { command: string }).command).startsWith('gh pr list')
        ? { decision: 'allow' }
        : { decision: 'deny', reason: 'Bash(gh pr diff:*)' },
    )
    const direct: string[][] = []
    on('process.run', ran(direct, () => ({ stdout: LIST })))
    const denied = await $.tool.call({ tool: TOOL, messages: [BROWSER[0], { version: 'v1.0', loadData: { surfaceId: 'prs', path: '/d', run: ['gh', 'pr', 'diff', '1'] } }] })
    expect(denied.deny).toContain('`gh pr diff 1`: denied by your permissions (Bash(gh pr diff:*))')
    await $.tool.call({ tool: TOOL, messages: BROWSER })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Button', text: 'Add roer-ui (not allowed)' })).toBeDefined()
    await ui.press({ key: 'prs.row/prs/0' })
    expect(await ui.find({ type: 'Text', text: /gh pr diff 36`: denied by your permissions/ })).toBeDefined()
    expect(direct).toEqual([['gh', 'pr', 'list', '--json', 'number,title']])
    await ui.unmount()
  })

  test('a command line quotes what the shell would split or expand', () => {
    expect(shellCommand(['gh', 'pr', 'diff', '36'])).toBe('gh pr diff 36')
    expect(shellCommand(['git', 'log', '--format=%h %s', "it's"])).toBe(`git log '--format=%h %s' 'it'\\''s'`)
    expect(shellCommand(['cat', '--', 'a;rm -rf ~'])).toBe("cat -- 'a;rm -rf ~'")
    expect(readLoad({ path: '/a', file: 'docs/a b.md' }, {}, '', 's', true)).toEqual({ surfaceId: 's', path: '/a', as: 'text', run: ['cat', '--', 'docs/a b.md'] })
  })

  test('a load that does not resolve says which argument, what it found, and where', () => {
    const model = { prs: [{ number: 36 }] }
    // The slip from a template: /number reads the root, not the item.
    expect(readLoad({ path: '/d', run: ['gh', 'pr', 'diff', { path: '/number' }] }, model, '/prs/0', 's', true)).toBe(
      'argument 4 of a load\'s run { "path": "/number" } found nothing at /number, not a string or a number; inside a template, "number" is the item\'s own',
    )
    expect(readLoad({ path: '/d', run: ['gh', 'pr', 'diff', { path: 'number' }] }, model, '/prs/0', 's', true)).toEqual({
      surfaceId: 's', path: '/d', as: 'text', run: ['gh', 'pr', 'diff', '36'],
    })
    expect(readLoad({ path: '/d', run: ['ls', true] }, model, '', 's', true)).toBe('argument 2 of a load\'s run is a boolean, not a string or a number')
    expect(readLoad({ path: '/d', file: { path: 'prs' } }, model, '', 's', true)).toBe('a load\'s file { "path": "prs" } found a list at /prs, not a path')
  })

  test('what a command takes off the data model is an id, a number or a path', () => {
    const model = { body: 'rm -rf ~; echo hi', flag: '--output=/etc/x', branch: 'feature/a-b', n: 36, cmd: 'sh' }
    const run = (argv: unknown[]) => readLoad({ path: '/d', run: argv }, model, '', 's', true)
    expect(typeof run(['sh', '-c', { path: '/body' }])).toBe('string')
    expect(run(['gh', 'pr', 'diff', { path: '/flag' }])).toBe('argument 4 of a load\'s run is bound to "--output=/etc/x", not an id, a number or a path')
    expect(run([{ path: '/cmd' }, 'x'])).toBe('a load\'s command is written out, never bound to the data model')
    expect(run(['git', 'log', { path: '/branch' }, { path: '/n' }])).toEqual({ surfaceId: 's', path: '/d', as: 'text', run: ['git', 'log', 'feature/a-b', '36'] })
    // Written out by the model, an argument is its own words, spaces and all.
    expect(run(['git', 'log', '--format=%h %s'])).toEqual({ surfaceId: 's', path: '/d', as: 'text', run: ['git', 'log', '--format=%h %s'] })
  })

  test('a load carries one source, and a message cannot carry a value', () => {
    expect(typeof readLoad({ path: '/a', run: ['ls'], file: 'x' }, {}, '', 's', true)).toBe('string')
    expect(typeof readLoad({ path: '/a' }, {}, '', 's', true)).toBe('string')
    expect(typeof readLoad({ path: '/a', run: [] }, {}, '', 's', true)).toBe('string')
    expect(typeof readLoad({ path: '/a', run: ['ls', { path: '/missing' }] }, {}, '', 's', true)).toBe('string')
    expect(typeof readLoad({ path: '/a', file: 'x', as: 'yaml' }, {}, '', 's', true)).toBe('string')
    expect(typeof readLoadData({ version: 'v1.0', loadData: { surfaceId: 's', path: '/a', value: 1 } })).toBe('string')
    expect(readLoadData({ version: 'v1.0', updateDataModel: {} })).toBeUndefined()
    expect(readLocal({ event: { name: 'x' } }, {}, '', 's')).toBeUndefined()
    expect(readLocal({ local: { load: [{ path: '/a', value: 1 }] } }, {}, '', 's')).toEqual({
      loads: [{ surfaceId: 's', path: '/a', as: 'text', value: 1 }],
    })
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
