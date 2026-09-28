// The A2UI v1.0 reducer and data binding, cut down from Roer's own
// (src/generative-ui/apply.ts, evaluate.ts) to what the pane draws. Pure:
// every function takes the surfaces and gives back new ones.

import type { RoerUiComponent, RoerUiSurface, RoerUiSurfaces } from '../types'

export const EMPTY: RoerUiSurfaces = { order: [], bySurface: {} }

type Message = Record<string, unknown>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Applies one message, or says why it was refused. */
export function apply(surfaces: RoerUiSurfaces, message: unknown): RoerUiSurfaces | string {
  if (!isRecord(message)) return 'a message is not an object'
  if (message.version !== 'v1.0') return `version is ${JSON.stringify(message.version)}, not "v1.0"`
  const body = message as Message
  if (isRecord(body.createSurface)) {
    const { surfaceId, components, dataModel, sendDataModel } = body.createSurface
    if (typeof surfaceId !== 'string' || surfaceId === '') return 'createSurface needs a surfaceId'
    const surface: RoerUiSurface = {
      components: indexed(components),
      dataModel: isRecord(dataModel) ? dataModel : {},
      sendDataModel: sendDataModel === true,
    }
    return {
      order: [...surfaces.order.filter(id => id !== surfaceId), surfaceId],
      bySurface: { ...surfaces.bySurface, [surfaceId]: surface },
    }
  }
  if (isRecord(body.updateComponents)) {
    const { surfaceId, components } = body.updateComponents
    const surface = typeof surfaceId === 'string' ? surfaces.bySurface[surfaceId] : undefined
    if (!surface) return `updateComponents names no surface on screen (${String(surfaceId)})`
    return put(surfaces, surfaceId as string, {
      ...surface,
      components: { ...surface.components, ...indexed(components) },
    })
  }
  if (isRecord(body.updateDataModel)) {
    const { surfaceId, path, value } = body.updateDataModel
    const surface = typeof surfaceId === 'string' ? surfaces.bySurface[surfaceId] : undefined
    if (!surface) return `updateDataModel names no surface on screen (${String(surfaceId)})`
    const pointer = typeof path === 'string' ? path : ''
    return put(surfaces, surfaceId as string, { ...surface, dataModel: setAt(surface.dataModel, pointer, value) })
  }
  if (isRecord(body.deleteSurface)) {
    const { surfaceId } = body.deleteSurface
    if (typeof surfaceId !== 'string') return 'deleteSurface needs a surfaceId'
    const { [surfaceId]: _gone, ...bySurface } = surfaces.bySurface
    return { order: surfaces.order.filter(id => id !== surfaceId), bySurface }
  }
  return 'the message has none of createSurface, updateComponents, updateDataModel, deleteSurface'
}

function put(surfaces: RoerUiSurfaces, id: string, surface: RoerUiSurface): RoerUiSurfaces {
  return { ...surfaces, bySurface: { ...surfaces.bySurface, [id]: surface } }
}

function indexed(list: unknown): Record<string, RoerUiComponent> {
  const out: Record<string, RoerUiComponent> = {}
  if (!Array.isArray(list)) return out
  for (const one of list) {
    if (isRecord(one) && typeof one.id === 'string' && typeof one.component === 'string') {
      out[one.id] = one as RoerUiComponent
    }
  }
  return out
}

/** A pointer made absolute: relative ones (no leading `/`) hang off `scope`,
 * the current template item. */
export function absolute(scope: string, path: string): string {
  if (path.startsWith('/')) return path
  return path === '' ? scope : `${scope}/${path}`
}

const tokens = (pointer: string): string[] =>
  pointer === '' ? [] : pointer.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))

export function getAt(model: unknown, pointer: string): unknown {
  let at = model
  for (const token of tokens(pointer)) {
    if (Array.isArray(at)) at = at[Number(token)]
    else if (isRecord(at)) at = at[token]
    else return undefined
  }
  return at
}

/** Writes `value` at `pointer`, copying on the way down; `undefined` deletes,
 * as updateDataModel defines it. */
export function setAt(model: Record<string, unknown>, pointer: string, value: unknown): Record<string, unknown> {
  const path = tokens(pointer)
  if (path.length === 0) return isRecord(value) ? value : {}
  const write = (at: unknown, depth: number): unknown => {
    const token = path[depth] as string
    const last = depth === path.length - 1
    if (Array.isArray(at)) {
      const copy = [...at]
      copy[Number(token)] = last ? value : write(copy[Number(token)], depth + 1)
      return copy
    }
    const copy: Record<string, unknown> = isRecord(at) ? { ...at } : {}
    if (last && value === undefined) delete copy[token]
    else copy[token] = last ? value : write(copy[token], depth + 1)
    return copy
  }
  return write(model, 0) as Record<string, unknown>
}

/** A dynamic value: a literal, or `{ path }` read from the data model.
 * Function calls are not evaluated in the pane yet. */
export function resolve(value: unknown, model: unknown, scope: string): unknown {
  if (isRecord(value) && typeof value.path === 'string') return getAt(model, absolute(scope, value.path))
  if (isRecord(value) && typeof value.call === 'string') return undefined
  return value
}

export const text = (value: unknown, model: unknown, scope: string): string => {
  const v = resolve(value, model, scope)
  return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
}

/** The bound pointer behind an input's value, when it is bound. */
export function binding(value: unknown, scope: string): string | undefined {
  return isRecord(value) && typeof value.path === 'string' ? absolute(scope, value.path) : undefined
}

/** A ChildList as (component id, scope) pairs: fixed ids share the scope,
 * a template repeats one component over each item of a bound list. */
export function children(list: unknown, model: unknown, scope: string): [string, string][] {
  if (Array.isArray(list)) return list.filter((id): id is string => typeof id === 'string').map(id => [id, scope])
  if (isRecord(list) && typeof list.componentId === 'string' && typeof list.path === 'string') {
    const at = absolute(scope, list.path)
    const items = getAt(model, at)
    const keys = Array.isArray(items) ? items.map((_, i) => String(i)) : isRecord(items) ? Object.keys(items) : []
    return keys.map(key => [list.componentId as string, `${at}/${key}`])
  }
  return []
}
