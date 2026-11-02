import { describe, expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'roer-ui',
  props: { title: 'Roer', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const ROOT = '/work/roer'
const ITEMS = {
  [`${ROOT}\u0000feature`]: {
    item: {
      title: 'Open tabs in a browser',
      status: 'review',
      goal: 'A tab as its own page',
      requirements: [{ id: 'r1', text: 'Opens from the tab menu', met: true }],
      decisions: [{ id: 'd1', question: 'Pin or follow?', options: [{ label: 'Pin', value: 'pin' }, { label: 'Follow', value: 'follow' }] }],
      findings: [{ id: 'f1', severity: 'warn', text: 'Flashes ended', at: { path: 'src/TabPage.tsx', line: 1 } }],
    },
  },
}
const PATCH = 'diff --git a/src/TabPage.tsx b/src/TabPage.tsx\n--- a/src/TabPage.tsx\n+++ b/src/TabPage.tsx\n@@ -1 +1 @@\n-old\n+new\n'

/** The machine as the command sees it: a repository on `branch`, and Roer's file of items. */
function machine(on: Parameters<Parameters<typeof test>[1]>[1], branch: string, items: unknown = ITEMS) {
  on('session.cwd', () => ({ value: ROOT }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'printenv ROER_HOME') return out('', 1)
    if (argv === 'printenv HOME') return out('/home/me\n')
    if (argv === 'git rev-parse --show-toplevel') return out(`${ROOT}\n`)
    if (argv === 'git branch --show-current') return out(`${branch}\n`)
    if (argv.startsWith('git diff')) return out(PATCH)
    return out('', 1)
  })
  on('fs.read', (_$, e) => {
    const path = typeof e === 'string' ? e : (e as { path: string }).path
    if (path === '/home/me/.roer/extension-data/work-item/items.json') return { value: JSON.stringify(items) }
    return { deny: 'ENOENT' }
  })
}

describe('/work-item', () => {
  test("draws Roer's item for the branch, with its uncommitted change", async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', () => ({ value: { command: 'work-item' } }))
    machine(on, 'feature')
    const ran = await $.command.run({ command: 'work-item' })
    expect(ran.text).toMatch(/Work item shown/)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'roer-ui', surface, ...PANE })
      for (const seen of ['Open tabs in a browser', 'A tab as its own page', 'Pin or follow?', 'Opens from the tab menu']) {
        expect(await ui.find({ text: seen }), `${surface}: ${seen}`).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('says so when the branch has no item', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    machine(on, 'main')
    await $.command.run({ command: 'work-item' })
    const ui = await $.ui.mount({ plugin: 'roer-ui', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No work item for this branch yet/ })).toBeDefined()
    await ui.unmount()
  })
})
