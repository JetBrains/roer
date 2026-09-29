// roer-ui: Roer's Generative UI drawn in a Claude Code pane instead of Roer's
// side panel. `/roer <what to show>` opens the pane and asks the model to
// draw it; the model draws through this mod's own `show` tool, which takes
// the same A2UI v1.0 messages as Roer's `show_ui`, so nothing here needs Roer
// running. A press in the pane comes back to the model as a prompt.
//
// Spike: layout, text and the basic inputs of the catalog. The rest of
// `roer:catalog/1` draws as a dim placeholder naming the component.

import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'
import type { RoerUiComponent, RoerUiSurface } from '../types'
import { EMPTY, apply, binding, children, contextOf, own, resolve, setAt, text } from './a2ui'
import {
  SOURCE_NAMES,
  progressValue,
  readChanges,
  readComments,
  readDecisions,
  readFindings,
  readNotes,
  readRequirements,
  readSources,
  shownValue,
  statusTone,
} from './workItem'
import type { Comment, Decision, Finding, FindingState, Note, Requirement, SourceRef, Tone } from './workItem'
import { bashRan, fetchLoad, opened, readLoadData, readLocal, shellCommand } from './local'
import type { Load, LocalAction, RunIo } from './local'

const PANE = 'roer-ui'
const TOOL = 'mcp__roer-ui__show'
const GUIDE_TOOL = 'mcp__roer-ui__guide'
const surfaces = atom({ plugin: 'roer-ui', key: 'surfaces' } as const, EMPTY)

const CATALOG = `Components (flat list, each { id, component, ...props }; one must have id "root"). Any component takes
weight (flex-grow inside a Row/Column).
Layout:
- Column / Row { children, justify?, align? } and List { children, direction? }: children is an array of ids, or a
  template { componentId, path } repeating one component per item of a data-model list (paths inside are relative to
  the item; { "call": "@index", args?: { offset } } is the item's position)
- Grid { children, columns?, minItemWidth? } wraps; Card { child }; Divider { axis? }; Tabs { tabs: [{ title, child }] };
  Modal { trigger, content }; Expandable { title, child, defaultExpanded? }; Arrow { direction?, label? }
Display:
- Text { text, variant?: "caption" | "body" }; Icon { name }; Image { url, description? }; Video { url };
  AudioPlayer { url, description? } (media is linked, not played)
Input:
- Button { child (usually a Text id), action: { event: { name, context?, userMessage? } }, variant?: "primary" | "borderless" }
- TextField { label, value?, placeholder?, variant?: "shortText" | "number" | "obscured" }, CheckBox { label, value },
  ChoicePicker { label?, options: [{ label, value }], value: [selected values], variant?: "mutuallyExclusive" |
  "multipleSelection", displayStyle?: "checkbox" | "chips", filterable? },
  Slider { max, value, min?, steps?, label? }, DateTimeInput { value, enableDate?, enableTime?, min?, max?, label? }
Roer's own:
- StatTile { label, value, trend?: { delta, direction: "up" | "down" | "flat" }, icon? }
- StatusCard { title, subtitle?, meta?, icon?, status?, progress? (0-100), url?, footer? }
- WorkItem { title, source?, key?, status?, url?, assignee?, labels?, meta?, footer? }; with variant: "detail" also goal,
  requirements [{ id, text, met }], decisions [{ id, question, options: [{ label, value }], answer? }],
  findings [{ id, severity: info|warn|error, text, at?: { changeId, path, line }, state? }], sources [{ kind, label, url?,
  path? }], comments [{ id, author, text, at? }], changes [{ id, title, patch }]. The person's ticks, answers and settled
  findings arrive as toggleRequirement / answerDecision / settleFinding events with the item's key as workItem.
- Requirements / Findings / Decisions / Sources / Comments { items }: one of those sections on its own
- DiffView { diff (a whole git diff), title?, emptyText?, notes?: [{ path, line?, text }] }
Any string/number/boolean prop may instead be { "path": "/json/pointer" } into the surface's dataModel; bind an
input's value that way and the person's edits write back to the data model.`

// The engine caps a tool's description at 4096 characters, so the catalog
// and the pane-side rules are the guide tool's answer, read before drawing.
const DESCRIPTION = `Show or update a UI in the Roer pane of this Claude Code session. Call ${GUIDE_TOOL} first, once
per session: it answers the component catalog and how the pane fetches data and handles presses itself.
\`messages\` is a list of A2UI v1.0 messages, each { "version": "v1.0", <one body> }: createSurface { surfaceId,
components, dataModel?, sendDataModel?, hidden? }, updateComponents { surfaceId, components }, updateDataModel
{ surfaceId, path?, value }, deleteSurface { surfaceId }, loadData { surfaceId, path, run | file, as? }.
Usually one createSurface with everything inline, then updates to the same surfaceId.
When the person presses a Button, its event arrives as a prompt starting "[roer-ui]" with the action as JSON
(and the data model when sendDataModel is true).`

const GUIDE = `${CATALOG}

Each press that reaches you, and every value you write out, costs the person a wait. Have the pane fetch what it
can, and handle presses that need no judgement of yours itself:
- { "version": "v1.0", "loadData": { surfaceId, path, run: [argv] | file, as?: "text" | "json" } } fills path with
  a command's standard output (argv, no shell, the session's working directory) or a file's text, parsed when as is
  "json". It lands after the messages before it; a command that fails refuses the whole call. For example
  run ["gh", "pr", "list", "--json", "number,title"], as "json", for a list's rows; ["gh", "pr", "diff", "36"] for a
  DiffView's diff.
- createSurface { ..., hidden: true } keeps a surface without drawing it, until a press opens it.
- Button action { local: { open?: surfaceId, load?: [{ path, run | file | value, as?, surfaceId? }] }, event? }:
  pressed, the pane itself draws the surface open names in place of the button's, and fills each load (into open's
  surface unless it names one, else the button's). run's arguments, file and value may be { "path" } off the pressed
  item. Nothing reaches you unless event is there too. Use it for navigation (a hidden detail surface, a back button
  opening the list again), drill-downs, and load or refresh buttons; keep event for what needs you.
- Commands in loadData and action.local run as your own Bash calls do, under the person's permissions: what their
  rules and mode allow runs at once, what needs asking opens the permission dialog when the call lands or the button
  is pressed, and what they deny is refused. So a button may merge a PR or re-run a check; the pane marks one that
  will ask. Write a command's own words out; only ids, numbers and paths may come off the data model, never text you
  did not choose (a PR's body, a page, a file's contents).
- When a press does reach you, send only what changed (updateDataModel, updateComponents), not a new createSurface.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'roer',
      description: "Show Roer's Generative UI in a pane",
      argumentHint: '<what to show>',
    })
    await $.tool.register({
      name: 'show',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { messages: { type: 'array', items: { type: 'object' }, minItems: 1 } },
        required: ['messages'],
      },
    })
    await $.tool.register({
      name: 'guide',
      description: `The component catalog and pane-side rules for ${TOOL}. Read it before drawing.`,
    })
    return next(e)
  })

  on('command.run', { command: 'roer' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Roer', focus: true })
    const ask = e.args.trim()
    if (ask === '') return { text: 'Roer pane opened.' }
    // Not from here: a submit waits on the turn this hook is holding.
    const text = `${ask}\n\n(Draw this in the Roer pane with the ${TOOL} tool, after reading ${GUIDE_TOOL} if you have not.)`
    $.clock.after(0, () => void $.prompt.submit({ text }))
    return { text: 'Roer pane opened; asking Claude to draw it.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const wire = (e as unknown as { messages?: unknown }).messages
    if (!Array.isArray(wire) || wire.length === 0) return { deny: '`messages` needs at least one message' }
    // A loadData stands for the updateDataModel its output becomes. Tried
    // with a stand-in first, so a malformed call runs no command.
    const loads = wire.map(readLoadData)
    const bad = loads.findIndex(load => typeof load === 'string')
    if (bad >= 0) return { deny: `Nothing was shown: message ${bad + 1}: ${loads[bad] as string}` }
    const asUpdate = (load: Load, value: unknown) => ({ version: 'v1.0', updateDataModel: { surfaceId: load.surfaceId, path: load.path, value } })
    const standIns = wire.map((message, n) => {
      const load = loads[n] as Load | undefined
      return load === undefined ? message : asUpdate(load, '')
    })
    let tried: typeof EMPTY | string = await read($, surfaces)
    for (const [n, message] of standIns.entries()) {
      tried = apply(tried, message)
      if (typeof tried === 'string') return { deny: `Nothing was shown: message ${n + 1}: ${tried}` }
    }
    // The model's own call: its loads are asked about as its Bash calls are.
    const io: RunIo = {
      check: command => $.tool.check({ tool: 'Bash', input: { command } }),
      run: argv => $.process.run(argv, { timeoutMs: 60_000 }),
      bash: async command => {
        return bashRan(await $.tool.call({ tool: 'Bash', command, description: 'Load data for the Roer pane' }))
      },
      read: path => $.fs.read(path),
    }
    const fetched = await Promise.all(
      loads.map(load => (load === undefined || typeof load === 'string' ? undefined : fetchLoad(load, io))),
    )
    const failed = fetched.findIndex(got => typeof got === 'string')
    if (failed >= 0) return { deny: `Nothing was shown: message ${failed + 1}: ${fetched[failed] as string}` }
    const messages = wire.map((message, n) => {
      const load = loads[n] as Load | undefined
      const got = fetched[n] as { value: unknown } | undefined
      return load === undefined || got === undefined ? message : asUpdate(load, got.value)
    })
    let problem: string | undefined
    await update($, surfaces, before => {
      let after = before
      for (const [n, message] of messages.entries()) {
        const next = apply(after, message)
        if (typeof next === 'string') {
          problem = `message ${n + 1}: ${next}`
          return before
        }
        after = next
      }
      problem = undefined
      return after
    })
    if (problem !== undefined) return { deny: `Nothing was shown: ${problem}` }
    const opened = await $.ui.open({ id: PANE, title: 'Roer' })
    const where = opened.isPlaced ? 'the Roer pane' : `the Roer pane, which is waiting to be placed (${opened.reason})`
    return { result: `Sent ${messages.length} message(s) to ${where}.` }
  })

  on('tool.call', { tool: GUIDE_TOOL }, async () => ({ result: GUIDE }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button, Link, Code } = el
    // The mobile app draws no fields yet, whatever its table holds.
    const Input = e.surface !== 'mobile' && 'Input' in el ? el.Input : undefined
    const Select = e.surface !== 'mobile' && 'Select' in el ? el.Select : undefined
    const { order, bySurface } = await read($, surfaces)
    if (order.length === 0) {
      return (
        <Box>
          <Text dimColor>Nothing to show yet. Try /roer a form to file a bug</Text>
        </Box>
      )
    }
    const columns = Math.max(10, (e.props as { bodyColumns?: number }).bodyColumns ?? 60)
    // The permission decision for each command a drawn button would run.
    // A drawing names the ones it did not know; they are asked, then drawn
    // again.
    const verdicts = new Map<string, 'allow' | 'ask' | 'deny'>()
    const unchecked = new Set<string>()

    // Closures rather than helpers: the engine wants `$` spelled at each call
    // site, never handed to a function of the module's own.
    const change = (surfaceId: string, edit: (surface: RoerUiSurface) => RoerUiSurface) =>
      update($, surfaces, all => {
        const surface = own(all.bySurface, surfaceId)
        if (surface === undefined) return all
        return { ...all, bySurface: { ...all.bySurface, [surfaceId]: edit(surface) } }
      })
    const writeModel = (surfaceId: string, pointer: string | undefined, value: unknown) =>
      pointer === undefined
        ? undefined
        : change(surfaceId, surface => ({ ...surface, dataModel: setAt(surface.dataModel, pointer, value) }))
    // The pane's own state, never the data model's: nothing the agent sent
    // says which tab is showing, and a press must not report it.
    const setView = (surfaceId: string, at: string, value: unknown) =>
      change(surfaceId, surface => ({ ...surface, view: { ...surface.view, [at]: value } }))

    // Something the person did, handed to the model as v1.0's
    // renderer-to-agent `action` message, the way Roer's panel reports it,
    // but as a prompt.
    const send = async (
      surfaceId: string,
      sourceComponentId: string,
      name: string,
      context: Record<string, unknown>,
      said: string,
      userMessage?: string,
    ) => {
      // Read afresh: the drawing's copy predates whatever was typed since.
      const surface = own((await read($, surfaces)).bySurface, surfaceId)
      if (surface === undefined) return
      const message = {
        version: 'v1.0',
        action: {
          name,
          surfaceId,
          sourceComponentId,
          timestamp: new Date().toISOString(),
          context,
          ...(userMessage ? { userMessage } : {}),
        },
      }
      const lines = [`[roer-ui] ${userMessage || said}`, JSON.stringify(message)]
      if (surface.sendDataModel) lines.push(`dataModel: ${JSON.stringify(surface.dataModel)}`)
      await $.prompt.submit({ text: lines.join('\n') })
    }

    // What a press does in the pane itself: open a surface in place of the
    // pressed one at once, then fill each load. Each surface being filled
    // says so while it is; a later press on it wins over this one.
    const runLocal = async (from: string, local: LocalAction, label: string) => {
      const token = `${Date.now()}.${Math.random()}`
      const fetching = local.loads.filter(load => !('value' in load))
      const filling = [...new Set(fetching.map(load => load.surfaceId))]
      const into = (all: typeof EMPTY, load: Load, value: unknown) => {
        const surface = own(all.bySurface, load.surfaceId)
        if (surface === undefined) return all
        return { ...all, bySurface: { ...all.bySurface, [load.surfaceId]: { ...surface, dataModel: setAt(surface.dataModel, load.path, value) } } }
      }
      const marked = (all: typeof EMPTY, surfaceId: string, loading: unknown) => {
        const surface = own(all.bySurface, surfaceId)
        if (surface === undefined) return all
        return { ...all, bySurface: { ...all.bySurface, [surfaceId]: { ...surface, view: { ...surface.view, loading } } } }
      }
      await update($, surfaces, all => {
        let next = local.open === undefined ? all : opened(all, from, local.open)
        for (const load of local.loads) {
          // What is being fetched is cleared, never shown under the wrong title.
          next = into(next, load, 'value' in load ? load.value : null)
        }
        for (const surfaceId of filling) next = marked(next, surfaceId, { token })
        return next
      })
      if (fetching.length === 0) return
      // The person's press is theirs to vouch for, not the command: the
      // dialog, or the auto-mode classifier, weighs one against the other.
      const io: RunIo = {
        check: command => $.tool.check({ tool: 'Bash', input: { command } }),
        run: argv => $.process.run(argv, { timeoutMs: 60_000 }),
        bash: async command => {
          return bashRan(
            await $.tool.call({
              tool: 'Bash',
              command,
              description: `"${label}" in the Roer pane`,
              consent: `The user pressed "${label}" in the Roer pane.`,
            }),
          )
        },
        read: path => $.fs.read(path),
      }
      const got = await Promise.all(fetching.map(load => fetchLoad(load, io)))
      await update($, surfaces, all => {
        let next = all
        const mine = (surfaceId: string) => {
          const loading = own(own(next.bySurface, surfaceId)?.view ?? {}, 'loading') as { token?: string } | undefined
          return loading?.token === token
        }
        const current = filling.filter(mine)
        for (const [n, load] of fetching.entries()) {
          const one = got[n]
          if (current.includes(load.surfaceId) && typeof one === 'object') next = into(next, load, one.value)
        }
        for (const surfaceId of current) {
          const problems = fetching.flatMap((load, n) => (load.surfaceId === surfaceId && typeof got[n] === 'string' ? [got[n] as string] : []))
          next = marked(next, surfaceId, problems.length > 0 ? { failed: problems.join('; ') } : undefined)
        }
        return next
      })
    }

    const press = async (surfaceId: string, c: RoerUiComponent, label: string, scope: string) => {
      const event = (c.action as { event?: { name?: unknown; context?: unknown; userMessage?: unknown } } | undefined)?.event
      const hasEvent = event !== undefined && typeof event.name === 'string'
      const surface = own((await read($, surfaces)).bySurface, surfaceId)
      if (surface === undefined) return
      const model = surface.dataModel
      const local = readLocal(c.action, model, scope, surfaceId)
      if (typeof local === 'string') {
        $.ui.toast(`roer-ui: "${label}": ${local}`)
        return
      }
      if (local === undefined && !hasEvent) {
        $.ui.toast(`roer-ui: "${label}" has no event to send`)
        return
      }
      if (local !== undefined) await runLocal(surfaceId, local, label)
      if (!hasEvent) return
      const said = `The person pressed "${label}" in the ${surfaceId} UI.`
      await send(surfaceId, c.id, event.name as string, contextOf(event.context, model, scope), said, text(event.userMessage, model, scope))
    }

    // `ancestors` are the components on the way down to this one. The graph
    // is the model's, so it can loop back on itself; a loop draws as a
    // placeholder the moment it closes, as in Roer's GenerativeSurface. A
    // depth limit alone would first draw exponentially many nodes.
    const draw = (surfaceId: string, surface: RoerUiSurface, id: string, scope: string, ancestors: ReadonlySet<string>): RenderChildren => {
      if (ancestors.has(id)) return <Text dimColor>{`(cycle at ${id})`}</Text>
      const c = own(surface.components, id)
      if (c === undefined) return <Text dimColor>{`(missing ${id})`}</Text>
      const model = surface.dataModel
      const key = `${surfaceId}.${id}${scope}`
      const at = `${id}${scope}`
      const view = (name: string) => own(surface.view ?? {}, `${name}:${at}`)
      const below = new Set(ancestors).add(id)
      // A child with a `weight` grows inside its Row or Column, as flex-grow
      // does in Roer's panel.
      const weighed = (child: string, node: RenderChildren) => {
        const weight = own(surface.components, child)?.weight
        return typeof weight === 'number' ? <Box flexGrow={weight} flexDirection="column">{node}</Box> : node
      }
      const kids = (list: unknown) =>
        children(list, model, scope).map(([child, childScope]) => weighed(child, draw(surfaceId, surface, child, childScope, below)))
      const one = (child: unknown) => (typeof child === 'string' ? draw(surfaceId, surface, child, scope, below) : null)
      const value = (v: unknown) => resolve(v, model, scope)
      const str = (prop: string) => text(c[prop], model, scope)
      const write = (pointer: string | undefined, next: unknown) => writeModel(surfaceId, pointer, next)
      const link = (url: string, label: string) =>
        url.startsWith('https://') ? <Link href={url} label={label} /> : <Text>{label}</Text>

      switch (c.component) {
        case 'Column':
          return (
            <Box flexDirection="column" justifyContent={justify(c.justify)} alignItems={align(c.align)}>
              {kids(c.children)}
            </Box>
          )
        case 'Row':
          return (
            <Box flexDirection="row" gap={1} justifyContent={justify(c.justify)} alignItems={align(c.align)}>
              {kids(c.children)}
            </Box>
          )
        case 'List': {
          const isRow = c.direction === 'horizontal'
          return (
            <Box flexDirection={isRow ? 'row' : 'column'} gap={isRow ? 1 : 0} alignItems={align(c.align)}>
              {kids(c.children)}
            </Box>
          )
        }
        case 'Grid': {
          // The one layout that wraps. `columns` wins over `minItemWidth`, as
          // in Roer's panel; a pixel width becomes cells at 8 pixels each.
          const count = typeof c.columns === 'number' && c.columns >= 1 ? Math.floor(c.columns) : undefined
          const minWidth = typeof c.minItemWidth === 'number' ? Math.max(8, Math.ceil(c.minItemWidth / 8)) : 24
          return (
            <Box flexDirection="row" flexWrap="wrap" rowGap={1}>
              {kids(c.children).map(node => (
                <Box
                  flexDirection="column"
                  paddingRight={1}
                  width={count === undefined ? undefined : `${Math.floor(100 / count)}%`}
                  minWidth={count === undefined ? minWidth : undefined}
                >
                  {node}
                </Box>
              ))}
            </Box>
          )
        }
        case 'Card':
          return (
            <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1}>
              {one(c.child)}
            </Box>
          )
        case 'Tabs': {
          // A row of buttons, one per tab, and only the chosen tab's child.
          const tabs = Array.isArray(c.tabs) ? (c.tabs as { title?: unknown; child?: unknown }[]) : []
          if (tabs.length === 0) return null
          const chosen = view('tab')
          const shown = Math.min(Math.max(0, typeof chosen === 'number' ? chosen : 0), tabs.length - 1)
          return (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={2}>
                {tabs.map((tab, n) => {
                  const title = text(tab.title, model, scope) || `Tab ${n + 1}`
                  return (
                    <Button
                      key={`${key}.tab${n}`}
                      plain
                      label={n === shown ? `[${title}]` : title}
                      dimColor={n === shown ? undefined : true}
                      onPress={() => void setView(surfaceId, `tab:${at}`, n)}
                    />
                  )
                })}
              </Box>
              {one(tabs[shown]?.child)}
            </Box>
          )
        }
        case 'Modal': {
          // No layer to float it on: the trigger, a button that opens and
          // closes it, and the content in a frame beneath while open.
          const open = view('open') === true
          return (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1}>
                {one(c.trigger)}
                <Button key={`${key}.open`} plain dimColor label={open ? '▾ close' : '▸ open'} onPress={() => void setView(surfaceId, `open:${at}`, !open)} />
              </Box>
              {open && (
                <Box borderStyle="double" flexDirection="column" paddingX={1}>
                  {one(c.content)}
                </Box>
              )}
            </Box>
          )
        }
        case 'Expandable': {
          const set = view('expanded')
          const open = typeof set === 'boolean' ? set : c.defaultExpanded === true
          return (
            <Box flexDirection="column">
              <Button key={`${key}.toggle`} plain label={`${open ? '▾' : '▸'} ${str('title')}`} onPress={() => void setView(surfaceId, `expanded:${at}`, !open)} />
              {open && (
                <Box flexDirection="column" paddingLeft={2}>
                  {one(c.child)}
                </Box>
              )}
            </Box>
          )
        }
        case 'Divider':
          return c.axis === 'vertical' ? (
            <Text dimColor>│</Text>
          ) : (
            <Text dimColor wrap="truncate-end">{'─'.repeat(columns)}</Text>
          )
        case 'Arrow': {
          const label = str('label')
          if (c.direction === 'vertical') {
            return (
              <Box flexDirection="column" alignItems="center">
                <Text dimColor>│</Text>
                {label !== '' && <Text dimColor>{label}</Text>}
                <Text dimColor>▼</Text>
              </Box>
            )
          }
          return <Text dimColor>{label === '' ? '──▶' : `── ${label} ──▶`}</Text>
        }
        case 'Text':
          return <Text dimColor={c.variant === 'caption'}>{str('text')}</Text>
        case 'Icon':
          return <Text>{iconText(c.name, model, scope)}</Text>
        case 'Image': {
          // A terminal cannot fetch and draw a picture from a link: the pane
          // names it and links to it.
          const description = str('description')
          return link(str('url'), `[image${description ? `: ${description}` : ''}]`)
        }
        case 'Video':
          return link(str('url'), '▶ video')
        case 'AudioPlayer': {
          const description = str('description')
          return link(str('url'), `♪ ${description || 'audio'}`)
        }
        case 'Button': {
          const label = (typeof c.child === 'string' ? labelOf(own(surface.components, c.child), model, scope) : '') || id
          // What the person's permissions say of the commands a press would
          // run: marked when one would ask, or would be refused.
          const local = readLocal(c.action, model, scope, surfaceId)
          const commands = typeof local === 'object' ? local.loads.flatMap(load => ('run' in load ? [shellCommand(load.run)] : [])) : []
          const decisions = commands.map(command => {
            const decided = verdicts.get(command)
            if (decided === undefined) unchecked.add(command)
            return decided
          })
          const mark = decisions.includes('deny') ? ' (not allowed)' : decisions.includes('ask') ? ' (asks first)' : ''
          return (
            <Button
              key={key}
              label={`${label}${mark}`}
              variant={c.variant === 'primary' ? 'primary' : undefined}
              dimColor={c.variant === 'borderless' || decisions.includes('deny') ? true : undefined}
              onPress={() => void press(surfaceId, c, label, scope)}
            />
          )
        }
        case 'TextField': {
          const pointer = binding(c.value, scope)
          const shown = str('value')
          // No masked field in a terminal: an obscured one never shows its
          // value, only how long it is.
          const obscured = c.variant === 'obscured'
          const asTyped = (typed: string) =>
            c.variant === 'number' && typed.trim() !== '' && Number.isFinite(Number(typed)) ? Number(typed) : typed
          if (Input === undefined) return <Text>{`${str('label')}: ${obscured ? '•'.repeat(shown.length) : shown}`}</Text>
          return (
            <Input
              key={key}
              label={`${str('label')} `}
              placeholder={obscured ? '•'.repeat(shown.length) || undefined : str('placeholder') || undefined}
              value={obscured ? undefined : shown}
              onInput={typed => write(pointer, asTyped(typed))}
              onSubmit={typed => write(pointer, asTyped(typed))}
            />
          )
        }
        case 'CheckBox': {
          const isOn = value(c.value) === true
          return (
            <Button
              key={key}
              plain
              label={`${isOn ? '[x]' : '[ ]'} ${str('label')}`}
              onPress={() => write(binding(c.value, scope), !isOn)}
            />
          )
        }
        case 'ChoicePicker': {
          const options = (Array.isArray(c.options) ? c.options : []) as { label?: unknown; value?: unknown }[]
          const picked = value(c.value)
          const chosen = Array.isArray(picked) ? picked.map(String) : []
          const pointer = binding(c.value, scope)
          const multiple = c.variant === 'multipleSelection'
          const filter = c.filterable === true ? String(view('filter') ?? '') : ''
          const shown = options.filter(option => text(option.label, model, scope).toLowerCase().includes(filter.toLowerCase()))
          // As in Roer's panel: a single choice pressed again is cleared.
          const toggle = (v: string) =>
            write(pointer, multiple ? (chosen.includes(v) ? chosen.filter(x => x !== v) : [...chosen, v]) : chosen.includes(v) ? [] : [v])
          const filterBox =
            c.filterable === true && Input !== undefined ? (
              <Input key={`${key}.filter`} label="Filter " value={filter} onInput={typed => void setView(surfaceId, `filter:${at}`, typed)} onSubmit={typed => void setView(surfaceId, `filter:${at}`, typed)} />
            ) : null
          if (!multiple && c.displayStyle !== 'chips' && c.filterable !== true && Select !== undefined) {
            return (
              <Select
                key={key}
                label={c.label === undefined ? undefined : `${str('label')} `}
                options={options.map(option => ({ value: String(option.value), label: text(option.label, model, scope) }))}
                value={chosen[0]}
                onSelect={picked => write(pointer, [picked])}
              />
            )
          }
          const mark = (isOn: boolean) => (multiple ? (isOn ? '[x]' : '[ ]') : isOn ? '(•)' : '( )')
          const buttons = shown.map(option => {
            const v = String(option.value)
            const isOn = chosen.includes(v)
            const label = text(option.label, model, scope)
            return (
              <Button
                key={`${key}.${v}`}
                plain
                label={c.displayStyle === 'chips' ? (isOn ? `[${label}]` : ` ${label} `) : `${mark(isOn)} ${label}`}
                dimColor={c.displayStyle === 'chips' && !isOn ? true : undefined}
                onPress={() => toggle(v)}
              />
            )
          })
          return (
            <Box flexDirection="column">
              {c.label !== undefined && <Text>{str('label')}</Text>}
              {filterBox}
              {c.displayStyle === 'chips' ? <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{buttons}</Box> : buttons}
            </Box>
          )
        }
        case 'Slider': {
          const min = typeof c.min === 'number' ? c.min : 0
          const max = typeof c.max === 'number' && c.max > min ? c.max : min + 100
          const raw = Number(value(c.value) ?? min)
          const current = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min
          const step = typeof c.steps === 'number' && c.steps > 0 ? (max - min) / c.steps : (max - min) / 10
          const pointer = binding(c.value, scope)
          const to = (next: number) => write(pointer, Number(Math.min(max, Math.max(min, next)).toFixed(6)))
          const width = 20
          const filled = Math.round(((current - min) / (max - min)) * width)
          return (
            <Box flexDirection="row" gap={1}>
              {c.label !== undefined && <Text>{str('label')}</Text>}
              <Button key={`${key}.less`} plain label="◀" onPress={() => to(current - step)} />
              <Text>{`${'━'.repeat(filled)}${'─'.repeat(width - filled)}`}</Text>
              <Button key={`${key}.more`} plain label="▶" onPress={() => to(current + step)} />
              <Text key={`${key}.value`}>{String(current)}</Text>
            </Box>
          )
        }
        case 'DateTimeInput': {
          // Both flags default to off in v1.0; with neither set, offer both,
          // as Roer's panel does. Typed as text, in the format the value keeps.
          const date = c.enableDate === true
          const time = c.enableTime === true
          const format = date && !time ? 'YYYY-MM-DD' : time && !date ? 'HH:MM' : 'YYYY-MM-DDTHH:MM'
          const pointer = binding(c.value, scope)
          const range = [str('min'), str('max')].some(Boolean) ? ` (${str('min') || '…'} to ${str('max') || '…'})` : ''
          if (Input === undefined) return <Text>{`${str('label')}: ${str('value') || format}`}</Text>
          return (
            <Input
              key={key}
              label={`${str('label') || 'When'}${range} `}
              placeholder={format}
              value={str('value')}
              onInput={typed => write(pointer, typed)}
              onSubmit={typed => write(pointer, typed)}
            />
          )
        }
        case 'DiffView': {
          const patch = str('diff')
          const title = str('title')
          return (
            <Box flexDirection="column">
              {title !== '' && <Text bold>{title}</Text>}
              {patch.trim() === ''
                ? <Text dimColor>{c.emptyText === undefined ? 'No changes.' : str('emptyText')}</Text>
                : diffWithNotes(surfaceId, at, patch, readNotes(value(c.notes)))}
            </Box>
          )
        }
        case 'StatTile': {
          const trend = typeof c.trend === 'object' && c.trend !== null ? (c.trend as { delta?: unknown; direction?: unknown }) : undefined
          const up = trend?.direction === 'up'
          const down = trend?.direction === 'down'
          return (
            <Box borderStyle="round" borderDimColor flexDirection="row" gap={1} paddingX={1}>
              {c.icon !== undefined && <Text>{iconText(c.icon, model, scope)}</Text>}
              <Box flexDirection="column" flexGrow={1}>
                <Text bold>{str('value')}</Text>
                <Text dimColor>{str('label')}</Text>
              </Box>
              {trend && (
                <Text color={up ? 'green' : down ? 'red' : undefined} dimColor={!up && !down ? true : undefined}>
                  {`${up ? '▲' : down ? '▼' : '•'} ${text(trend.delta, model, scope)}`}
                </Text>
              )}
            </Box>
          )
        }
        case 'StatusCard': {
          const status = str('status')
          const progress = c.progress === undefined ? undefined : progressValue(value(c.progress))
          return (
            <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1}>
              <Box flexDirection="row" gap={1}>
                {c.icon !== undefined && <Text>{iconText(c.icon, model, scope)}</Text>}
                <Box flexGrow={1}>{link(str('url'), str('title'))}</Box>
                {status !== '' && <Text color={toneColor(statusTone(status))}>{status}</Text>}
              </Box>
              {c.subtitle !== undefined && <Text dimColor>{str('subtitle')}</Text>}
              {progress !== undefined && <Text key={`${key}.progress`}>{bar(progress)}</Text>}
              {c.meta !== undefined && <Text dimColor>{str('meta')}</Text>}
              {one(c.footer)}
            </Box>
          )
        }
        case 'WorkItem': {
          const status = str('status')
          const source = str('source')
          const itemKey = str('key')
          const assignee = str('assignee')
          const labels = value(c.labels)
          const tags = Array.isArray(labels) ? labels.map(String) : []
          const origin = [SOURCE_NAMES[source.toLowerCase()] ?? source, itemKey].filter(Boolean).join(' ')
          return (
            <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1}>
              <Box flexDirection="row" gap={1}>
                {origin !== '' && <Text dimColor>{origin}</Text>}
                <Box flexGrow={1}>{link(str('url'), str('title'))}</Box>
                {status !== '' && <Text color={toneColor(statusTone(status))}>{status}</Text>}
              </Box>
              {(assignee !== '' || tags.length > 0) && (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  {assignee !== '' && <Text>{`@${assignee}`}</Text>}
                  {tags.map(tag => <Text dimColor>{`[${tag}]`}</Text>)}
                </Box>
              )}
              {c.meta !== undefined && <Text dimColor>{str('meta')}</Text>}
              {one(c.footer)}
              {c.variant === 'detail' && detail(surfaceId, surface, c, scope, itemKey)}
            </Box>
          )
        }
        case 'Requirements':
          return requirements(surfaceId, surface, c, scope, readRequirements(value(c.items)), undefined)
        case 'Findings':
          return findings(surfaceId, surface, c, scope, readFindings(value(c.items)), undefined)
        case 'Decisions':
          return decisions(surfaceId, surface, c, scope, readDecisions(value(c.items)), undefined)
        case 'Sources':
          return section('Sources', undefined, sources(readSources(value(c.items))))
        case 'Comments':
          return section('Comments', undefined, comments(readComments(value(c.items))))
        default:
          return <Text dimColor>{`[${c.component}: not in roer:catalog/1]`}</Text>
      }
    }

    // A work item opened up, in the order Roer's panel draws it: its goal,
    // what needs the person, the requirements, where it came from, the
    // discussion, and what changed.
    const detail = (surfaceId: string, surface: RoerUiSurface, c: RoerUiComponent, scope: string, itemKey: string) => {
      const value = (v: unknown) => resolve(v, surface.dataModel, scope)
      const goal = text(c.goal, surface.dataModel, scope)
      const found = localized(surface, c, scope, 'state', readFindings(value(c.findings)))
      const asked = localized(surface, c, scope, 'answer', readDecisions(value(c.decisions)))
      const reqs = readRequirements(value(c.requirements))
      const srcs = readSources(value(c.sources))
      const talk = readComments(value(c.comments))
      const changes = readChanges(value(c.changes))
      const waiting = asked.filter(d => d.answer === undefined).length + found.filter(f => f.state === 'open').length
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {goal !== '' && <Text>{goal}</Text>}
          {asked.length + found.length > 0 &&
            section('Needs you', waiting > 0 ? String(waiting) : 'nothing open', [
              decisionRows(surfaceId, c, scope, asked, itemKey),
              findingRows(surfaceId, c, scope, found, itemKey),
            ])}
          {reqs.length > 0 && requirements(surfaceId, surface, c, scope, reqs, itemKey)}
          {srcs.length > 0 && section('Sources', undefined, sources(srcs))}
          {talk.length > 0 && section('Comments', undefined, comments(talk))}
          {changes.length > 0 &&
            section(
              'Changes',
              undefined,
              changes.map(one => {
                const at = `change:${c.id}${scope}:${one.id}`
                const set = own(surface.view ?? {}, at)
                const open = typeof set === 'boolean' ? set : changes.length === 1
                // An open finding about a line of this change is drawn there too.
                const notes = [
                  ...(one.notes ?? []),
                  ...found
                    .filter(f => f.state === 'open' && f.at?.changeId === one.id)
                    .map(f => ({ path: f.at!.path, line: f.at!.line, text: `${f.severity}: ${f.text}` })),
                ]
                return (
                  <Box flexDirection="column">
                    <Button key={`${surfaceId}.${c.id}${scope}.change.${one.id}`} plain label={`${open ? '▾' : '▸'} ${one.title}`} onPress={() => void setView(surfaceId, at, !open)} />
                    {open && <Box paddingLeft={2} flexDirection="column">{diffWithNotes(surfaceId, at, one.patch, notes)}</Box>}
                  </Box>
                )
              }),
            )}
        </Box>
      )
    }

    // The person's own values over the agent's, as long as the agent's value
    // is still the one they replaced. See `shownValue`.
    const localized = <T extends { id: string }, K extends keyof T>(surface: RoerUiSurface, c: RoerUiComponent, scope: string, field: K, items: T[]): T[] =>
      items.map(item => ({ ...item, [field]: shownValue(own(surface.view ?? {}, `local:${c.id}${scope}:${String(field)}:${item.id}`), item[field]) }))
    const answer = (surfaceId: string, c: RoerUiComponent, scope: string, field: string, id: string, base: unknown, next: unknown) =>
      setView(surfaceId, `local:${c.id}${scope}:${field}:${id}`, { base: base ?? null, value: next })
    // As a button's event would: the item's key rides along as `workItem`
    // when the section is part of one.
    const report = (surfaceId: string, c: RoerUiComponent, name: string, context: Record<string, unknown>, itemKey: string | undefined) =>
      send(surfaceId, c.id, name, itemKey === undefined ? context : { workItem: itemKey, ...context }, `The person did ${name} in the ${surfaceId} UI.`)

    const section = (title: string, aside: string | undefined, body: RenderChildren) => (
      <Box flexDirection="column">
        <Text bold>{aside === undefined ? title : `${title} · ${aside}`}</Text>
        {body}
      </Box>
    )

    const requirements = (surfaceId: string, surface: RoerUiSurface, c: RoerUiComponent, scope: string, raw: Requirement[], itemKey: string | undefined) => {
      const items = localized(surface, c, scope, 'met', raw)
      const met = items.filter(r => r.met).length
      return section(
        'Requirements',
        `${met} of ${items.length}`,
        items.map((r, n) => (
          <Button
            key={`${surfaceId}.${c.id}${scope}.req.${r.id}`}
            plain
            label={`${r.met ? '[x]' : '[ ]'} ${r.text}`}
            dimColor={r.met ? true : undefined}
            onPress={() => {
              void answer(surfaceId, c, scope, 'met', r.id, raw[n]?.met, !r.met)
              void report(surfaceId, c, 'toggleRequirement', { id: r.id, met: !r.met }, itemKey)
            }}
          />
        )),
      )
    }

    const findings = (surfaceId: string, surface: RoerUiSurface, c: RoerUiComponent, scope: string, raw: Finding[], itemKey: string | undefined) =>
      section('Findings', undefined, findingRows(surfaceId, c, scope, localized(surface, c, scope, 'state', raw), itemKey, raw))

    // Open ones first: they are what the section is for.
    const findingRows = (surfaceId: string, c: RoerUiComponent, scope: string, items: Finding[], itemKey: string | undefined, raw?: Finding[]) => {
      const sorted = [...items.filter(f => f.state === 'open'), ...items.filter(f => f.state !== 'open')]
      const base = (id: string) => (raw ?? items).find(f => f.id === id)?.state
      const settle = (f: Finding, state: FindingState) => {
        void answer(surfaceId, c, scope, 'state', f.id, base(f.id) ?? f.state, state)
        void report(surfaceId, c, 'settleFinding', { id: f.id, state }, itemKey)
      }
      return sorted.map(f => {
        const keyOf = `${surfaceId}.${c.id}${scope}.finding.${f.id}`
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={f.severity === 'error' ? 'red' : f.severity === 'warn' ? 'yellow' : 'cyan'} dimColor={f.state === 'open' ? undefined : true}>
                {f.severity}
              </Text>
              <Text dimColor={f.state === 'open' ? undefined : true}>{f.text}</Text>
              {f.at && <Text dimColor>{`${f.at.path}:${f.at.line}`}</Text>}
            </Box>
            <Box flexDirection="row" gap={2} paddingLeft={2}>
              {f.state === 'open' ? (
                [
                  <Button key={`${keyOf}.resolve`} plain label="Resolve" onPress={() => settle(f, 'resolved')} />,
                  <Button key={`${keyOf}.dismiss`} plain dimColor label="Dismiss" onPress={() => settle(f, 'dismissed')} />,
                ]
              ) : (
                [<Text dimColor>{f.state}</Text>, <Button key={`${keyOf}.reopen`} plain dimColor label="Reopen" onPress={() => settle(f, 'open')} />]
              )}
            </Box>
          </Box>
        )
      })
    }

    const decisions = (surfaceId: string, surface: RoerUiSurface, c: RoerUiComponent, scope: string, raw: Decision[], itemKey: string | undefined) =>
      section('Decisions', undefined, decisionRows(surfaceId, c, scope, localized(surface, c, scope, 'answer', raw), itemKey, raw))

    // An option pressed is the answer, as is anything written under Other.
    // An answered one shows what it was, with Change to answer again.
    const decisionRows = (surfaceId: string, c: RoerUiComponent, scope: string, items: Decision[], itemKey: string | undefined, raw?: Decision[]) =>
      items.map(d => {
        const keyOf = `${surfaceId}.${c.id}${scope}.decision.${d.id}`
        const editing = own(own(bySurface, surfaceId)?.view ?? {}, `editing:${c.id}${scope}:${d.id}`) === true
        const base = (raw ?? items).find(x => x.id === d.id)?.answer
        const decide = (value: string) => {
          if (value.trim() === '') return
          void answer(surfaceId, c, scope, 'answer', d.id, base, value.trim())
          void setView(surfaceId, `editing:${c.id}${scope}:${d.id}`, false)
          void report(surfaceId, c, 'answerDecision', { id: d.id, answer: value.trim() }, itemKey)
        }
        if (d.answer !== undefined && d.answer !== null && !editing) {
          const label = d.options.find(o => o.value === d.answer)?.label ?? d.answer
          return (
            <Box flexDirection="column">
              <Text>{d.question}</Text>
              <Box flexDirection="row" gap={2} paddingLeft={2}>
                <Text dimColor>{`Answered: ${label}`}</Text>
                <Button key={`${keyOf}.change`} plain dimColor label="Change" onPress={() => void setView(surfaceId, `editing:${c.id}${scope}:${d.id}`, true)} />
              </Box>
            </Box>
          )
        }
        return (
          <Box flexDirection="column">
            <Text>{d.question}</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {d.options.map(o => (
                <Button key={`${keyOf}.${o.value}`} plain label={`${d.answer === o.value ? '(•)' : '( )'} ${o.label}`} onPress={() => decide(o.value)} />
              ))}
              {Input !== undefined && <Input key={`${keyOf}.other`} label="Other " placeholder="your own answer" onSubmit={typed => decide(typed)} />}
            </Box>
          </Box>
        )
      })

    const sources = (items: SourceRef[]) =>
      items.map(s => {
        // A path is the project's, with no file viewer here to open it in:
        // it is named. Only https leaves for the browser.
        const label = `${s.kind}  ${s.label}`
        return s.url?.startsWith('https://') ? (
          <Link href={s.url} label={label} />
        ) : (
          <Text>{s.path ? `${label}  ${s.path}` : label}</Text>
        )
      })

    const comments = (items: Comment[]) =>
      items.map(one => (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{one.author}</Text>
            {one.at !== undefined && <Text dimColor>{one.at}</Text>}
          </Box>
          <Text>{one.text}</Text>
        </Box>
      ))

    // The engine refuses a drawing of more than 100000 characters of text,
    // so the diffs on screen share a budget under that, leaving the rest
    // room. Each drawing starts it over.
    let diffRoom = DIFF_BUDGET

    // A whole `git diff`, one file at a time under a header that opens and
    // closes it, each file's notes under it: by line where they name one,
    // first where they do not. The files the person opened take the budget
    // first, then the rest are open while they fit; an open one that does
    // not fit says so.
    const diffWithNotes = (surfaceId: string, at: string, patch: string, notes: Note[]) => {
      const files = splitPatch(patch).map(file => {
        const where = `file:${at}:${file.path}`
        const set = own(own(bySurface, surfaceId)?.view ?? {}, where)
        return { ...file, where, set: typeof set === 'boolean' ? set : undefined, drawn: false }
      })
      for (const asked of [true, undefined])
        for (const file of files)
          if (file.set === asked && file.text.length <= diffRoom) {
            file.drawn = true
            diffRoom -= file.text.length
          }
      return files.map(file => {
        const mine = notes.filter(note => note.path === file.path)
        const where = file.where
        const open = file.set ?? file.drawn
        const fits = file.drawn
        const { added, removed } = counts(file.text)
        return (
          <Box flexDirection="column">
            <Button key={`${surfaceId}.${at}.file.${file.path}`} plain label={`${open ? '▾' : '▸'} ${file.path}  +${added} −${removed}`} onPress={() => void setView(surfaceId, where, !open)} />
            {open &&
              (fits ? (
                diffPieces(file.text).map(text => <Code source={text} format="diff" path={file.path} />)
              ) : (
                <Text dimColor>{'  Too long to draw with the other open files: close one to see this one.'}</Text>
              ))}
            {mine
              .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
              .map(note => (
                <Text color="yellow">{`  ${note.line === undefined ? file.path : `${file.path}:${note.line}${note.side === 'old' ? ' (old)' : ''}`}  ${note.text}`}</Text>
              ))}
          </Box>
        )
      })
    }

    const drawing = () => {
      diffRoom = DIFF_BUDGET
      return (
      <Box flexDirection="column" gap={1}>
        {order.flatMap(surfaceId => {
          const surface = own(bySurface, surfaceId) as RoerUiSurface
          if (surface.hidden === true) return []
          const loading = own(surface.view ?? {}, 'loading') as { token?: string; failed?: string } | undefined
          return [
            <Box flexDirection="column">
              {loading?.token !== undefined && <Text key={`${surfaceId}.loading`} dimColor>Loading…</Text>}
              {loading?.failed !== undefined && <Text key={`${surfaceId}.failed`} color="red">{loading.failed}</Text>}
              {draw(surfaceId, surface, 'root', '', new Set())}
            </Box>,
          ]
        })}
      </Box>
      )
    }
    const first = drawing()
    if (unchecked.size === 0) return first
    const asked = await Promise.all([...unchecked].map(command => $.tool.check({ tool: 'Bash', input: { command } })))
    for (const [n, command] of [...unchecked].entries()) verdicts.set(command, asked[n]?.decision ?? 'ask')
    return drawing()
  })
}

function justify(value: unknown) {
  switch (value) {
    case 'center':
      return 'center'
    case 'end':
      return 'flex-end'
    case 'spaceBetween':
      return 'space-between'
    case 'spaceAround':
      return 'space-around'
    case 'spaceEvenly':
      return 'space-evenly'
    default:
      return undefined
  }
}

function align(value: unknown) {
  switch (value) {
    case 'start':
      return 'flex-start'
    case 'center':
      return 'center'
    case 'end':
      return 'flex-end'
    case 'stretch':
      return 'stretch'
    default:
      return undefined
  }
}

/** A Button's label: the text of its child, when that is a Text. */
function labelOf(child: RoerUiComponent | undefined, model: unknown, scope: string): string {
  return child?.component === 'Text' ? text(child.text, model, scope) : ''
}

/** An icon's name as text, or a mark for a 24×24 svg path, which a terminal
 * cannot draw. */
function iconText(icon: unknown, model: unknown, scope: string): string {
  return typeof icon === 'object' && icon !== null && 'svgPath' in icon ? '◆' : text(icon, model, scope)
}

const TONE_COLORS = { done: 'green', doing: 'cyan', blocked: 'yellow', failed: 'red', todo: undefined } as const
const toneColor = (tone: Tone) => TONE_COLORS[tone]

/** A progress bar: 0–100 across twenty cells. */
function bar(progress: number): string {
  const filled = Math.round(progress / 5)
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${Math.round(progress)}%`
}

/** The engine refuses a Code source past 10000 characters. */
const CODE_LIMIT = 10_000

/** Characters of diff one drawing holds, under the engine's 100000 for all
 * its text. */
const DIFF_BUDGET = 60_000

/** A file's diff's added and removed lines, read from its first hunk on. */
function counts(text: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let hunks = false
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) hunks = true
    else if (hunks && line.startsWith('+')) added++
    else if (hunks && line.startsWith('-')) removed++
  }
  return { added, removed }
}

/** One file's diff in pieces a Code takes: each a whole diff of its own,
 * the file's header over as many hunks as fit. A hunk too long for one
 * piece is cut into hunks with their own counts, and a line too long for
 * any is cut short. */
function diffPieces(text: string): string[] {
  if (text.length <= CODE_LIMIT) return [text]
  const lines = text.split('\n')
  const first = lines.findIndex(line => line.startsWith('@@'))
  if (first < 0) return [text.slice(0, CODE_LIMIT)]
  const header = lines.slice(0, first).join('\n')
  // Room for a hunk under the header, and for its lines under an @@ line.
  const room = CODE_LIMIT - header.length - 1
  const body = room - 64
  const hunks: string[] = []
  let old = 0
  let now = 0
  let rows: string[] = []
  let size = 0
  let from = { old: 0, now: 0 }
  const flush = () => {
    if (rows.length === 0) return
    const oldCount = rows.filter(row => !row.startsWith('+') && !row.startsWith('\\')).length
    const nowCount = rows.filter(row => !row.startsWith('-') && !row.startsWith('\\')).length
    // An empty side names the line before it, as git writes it.
    const at = (start: number, count: number) => `${count === 0 ? start - 1 : start},${count}`
    hunks.push(`@@ -${at(from.old, oldCount)} +${at(from.now, nowCount)} @@\n${rows.join('\n')}`)
    rows = []
    size = 0
  }
  for (const line of lines.slice(first)) {
    const opened = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (opened) {
      flush()
      old = Number(opened[1]) + (opened[2] === '0' ? 1 : 0)
      now = Number(opened[3]) + (opened[4] === '0' ? 1 : 0)
      from = { old, now }
      continue
    }
    const row = line.length > body ? `${line.slice(0, body - 1)}…` : line
    if (size + row.length + 1 > body) {
      flush()
      from = { old, now }
    }
    rows.push(row)
    size += row.length + 1
    if (!line.startsWith('+') && !line.startsWith('\\')) old++
    if (!line.startsWith('-') && !line.startsWith('\\')) now++
  }
  flush()
  const pieces: string[] = []
  let piece = ''
  for (const hunk of hunks) {
    if (piece !== '' && piece.length + 1 + hunk.length > room) {
      pieces.push(`${header}\n${piece}`)
      piece = ''
    }
    piece = piece === '' ? hunk : `${piece}\n${hunk}`
  }
  if (piece !== '') pieces.push(`${header}\n${piece}`)
  return pieces
}

/** A whole `git diff` split into its files, each with its own header. */
function splitPatch(patch: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (part.trim() === '') continue
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part)
    const plus = /^\+\+\+ b\/(.+)$/m.exec(part)
    files.push({ path: plus?.[1] ?? header?.[2] ?? '', text: part.replace(/\n$/, '') })
  }
  return files
}
