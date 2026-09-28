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

const PANE = 'roer-ui'
const TOOL = 'mcp__roer-ui__show'
const surfaces = atom({ plugin: 'roer-ui', key: 'surfaces' } as const, EMPTY)

const CATALOG = `Components (flat list, each { id, component, ...props }; one must have id "root"):
- Column / Row { children } and List { children, direction? }: children is an array of ids, or a template
  { componentId, path } repeating one component per item of a data-model list (paths inside are relative to the item)
- Card { child }, Divider {}, Tabs { tabs: [{ title, child }] }
- Text { text, variant?: "caption" | "body" }
- Button { child (usually a Text id), action: { event: { name, context? } }, variant?: "primary" | "borderless" }
- TextField { label, value?, placeholder? }, CheckBox { label, value },
  ChoicePicker { label?, options: [{ label, value }], value: [selected values], variant?: "mutuallyExclusive" | "multipleSelection" }
Any string/number/boolean prop may instead be { "path": "/json/pointer" } into the surface's dataModel; bind an
input's value that way and the person's edits write back to the data model.`

const DESCRIPTION = `Show or update a UI in the Roer pane of this Claude Code session. \`messages\` is a list of A2UI v1.0
messages, each { "version": "v1.0", <one body> }: createSurface { surfaceId, components, dataModel?, sendDataModel? },
updateComponents { surfaceId, components }, updateDataModel { surfaceId, path?, value }, deleteSurface { surfaceId }.
Usually one createSurface with everything inline, then updates to the same surfaceId.
When the person presses a Button, its event arrives as a prompt starting "[roer-ui]" with the action as JSON
(and the data model when sendDataModel is true).

${CATALOG}`

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
    return next(e)
  })

  on('command.run', { command: 'roer' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Roer', focus: true })
    const ask = e.args.trim()
    if (ask === '') return { text: 'Roer pane opened.' }
    // Not from here: a submit waits on the turn this hook is holding.
    const text = `${ask}\n\n(Draw this in the Roer pane with the ${TOOL} tool. Its description has the component catalog.)`
    $.clock.after(0, () => void $.prompt.submit({ text }))
    return { text: 'Roer pane opened; asking Claude to draw it.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const messages = (e as unknown as { messages?: unknown }).messages
    if (!Array.isArray(messages) || messages.length === 0) return { deny: '`messages` needs at least one message' }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
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

    // Closures rather than helpers: the engine wants `$` spelled at each call
    // site, never handed to a function of the module's own.
    const writeModel = (surfaceId: string, pointer: string | undefined, value: unknown) => {
      if (pointer === undefined) return undefined
      return update($, surfaces, all => {
        const surface = own(all.bySurface, surfaceId)
        if (surface === undefined) return all
        const dataModel = setAt(surface.dataModel, pointer, value)
        return { ...all, bySurface: { ...all.bySurface, [surfaceId]: { ...surface, dataModel } } }
      })
    }

    // Which tab a Tabs shows is the pane's to keep, not the data model's:
    // nothing the agent sent says, and a press must not report it.
    const selectTab = (surfaceId: string, tabsAt: string, index: number) =>
      update($, surfaces, all => {
        const surface = own(all.bySurface, surfaceId)
        if (surface === undefined) return all
        const tabs = { ...surface.tabs, [tabsAt]: index }
        return { ...all, bySurface: { ...all.bySurface, [surfaceId]: { ...surface, tabs } } }
      })

    // A Button's event, handed to the model as v1.0's renderer-to-agent
    // `action` message, the way Roer's panel reports it, but as a prompt.
    const press = async (surfaceId: string, c: RoerUiComponent, label: string, scope: string) => {
      const event = (c.action as { event?: { name?: unknown; context?: unknown; userMessage?: unknown } } | undefined)?.event
      if (event === undefined || typeof event.name !== 'string') {
        $.ui.toast(`roer-ui: "${label}" has no event to send`)
        return
      }
      // Read afresh: the drawing's copy predates whatever was typed since.
      const surface = own((await read($, surfaces)).bySurface, surfaceId)
      if (surface === undefined) return
      const model = surface.dataModel
      const context = contextOf(event.context, model, scope)
      const userMessage = text(event.userMessage, model, scope)
      const message = {
        version: 'v1.0',
        action: {
          name: event.name,
          surfaceId,
          sourceComponentId: c.id,
          timestamp: new Date().toISOString(),
          context,
          ...(userMessage ? { userMessage } : {}),
        },
      }
      const said = userMessage || `The person pressed "${label}" in the ${surfaceId} UI.`
      const lines = [`[roer-ui] ${said}`, JSON.stringify(message)]
      if (surface.sendDataModel) lines.push(`dataModel: ${JSON.stringify(model)}`)
      await $.prompt.submit({ text: lines.join('\n') })
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
      const below = new Set(ancestors).add(id)
      const kids = (list: unknown) =>
        children(list, model, scope).map(([child, at]) => draw(surfaceId, surface, child, at, below))
      const one = (child: unknown) => (typeof child === 'string' ? draw(surfaceId, surface, child, scope, below) : null)
      const str = (prop: string) => text(c[prop], model, scope)
      const write = (pointer: string | undefined, value: unknown) => writeModel(surfaceId, pointer, value)

      switch (c.component) {
        case 'Column':
          return <Box flexDirection="column" justifyContent={justify(c.justify)}>{kids(c.children)}</Box>
        case 'Row':
          return <Box flexDirection="row" gap={1} justifyContent={justify(c.justify)}>{kids(c.children)}</Box>
        case 'List': {
          const isRow = c.direction === 'horizontal'
          return <Box flexDirection={isRow ? 'row' : 'column'} gap={isRow ? 1 : 0}>{kids(c.children)}</Box>
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
          const tabsAt = `${id}${scope}`
          const chosen = own(surface.tabs ?? {}, tabsAt) ?? 0
          const shown = Math.min(Math.max(0, chosen), tabs.length - 1)
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
                      onPress={() => void selectTab(surfaceId, tabsAt, n)}
                    />
                  )
                })}
              </Box>
              {one(tabs[shown]?.child)}
            </Box>
          )
        }
        case 'Divider':
          return <Text dimColor wrap="truncate-end">{'─'.repeat(columns)}</Text>
        case 'Text':
          return <Text dimColor={c.variant === 'caption'}>{str('text')}</Text>
        case 'Button': {
          const label = (typeof c.child === 'string' ? labelOf(own(surface.components, c.child), model, scope) : '') || id
          return (
            <Button
              key={key}
              label={label}
              variant={c.variant === 'primary' ? 'primary' : undefined}
              dimColor={c.variant === 'borderless' ? true : undefined}
              onPress={() => void press(surfaceId, c, label, scope)}
            />
          )
        }
        case 'TextField': {
          if (Input === undefined) return <Text>{`${str('label')}: ${str('value')}`}</Text>
          const pointer = binding(c.value, scope)
          return (
            <Input
              key={key}
              label={`${str('label')} `}
              placeholder={str('placeholder') || undefined}
              value={str('value')}
              onInput={value => write(pointer, value)}
              onSubmit={value => write(pointer, value)}
            />
          )
        }
        case 'CheckBox': {
          const isOn = resolve(c.value, model, scope) === true
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
          const picked = resolve(c.value, model, scope)
          const chosen = Array.isArray(picked) ? picked.map(String) : []
          const pointer = binding(c.value, scope)
          if (c.variant === 'multipleSelection') {
            return (
              <Box flexDirection="column">
                {c.label !== undefined && <Text>{str('label')}</Text>}
                {options.map(option => {
                  const value = String(option.value)
                  const isOn = chosen.includes(value)
                  return (
                    <Button
                      key={`${key}.${value}`}
                      plain
                      label={`${isOn ? '[x]' : '[ ]'} ${text(option.label, model, scope)}`}
                      onPress={() => write(pointer, isOn ? chosen.filter(v => v !== value) : [...chosen, value])}
                    />
                  )
                })}
              </Box>
            )
          }
          if (Select === undefined) return <Text>{`${str('label')}: ${chosen.join(', ')}`}</Text>
          return (
            <Select
              key={key}
              label={c.label === undefined ? undefined : `${str('label')} `}
              options={options.map(option => ({ value: String(option.value), label: text(option.label, model, scope) }))}
              value={chosen[0]}
              onSelect={value => write(pointer, [value])}
            />
          )
        }
        default:
          return <Text dimColor>{`[${c.component}: not drawn in the terminal yet]`}</Text>
      }
    }

    return (
      <Box flexDirection="column" gap={1}>
        {order.map(surfaceId => draw(surfaceId, own(bySurface, surfaceId) as RoerUiSurface, 'root', '', new Set()))}
      </Box>
    )
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

/** A Button's label: the text of its child, when that is a Text. */
function labelOf(child: RoerUiComponent | undefined, model: unknown, scope: string): string {
  return child?.component === 'Text' ? text(child.text, model, scope) : ''
}
