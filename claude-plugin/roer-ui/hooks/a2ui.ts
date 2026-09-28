// The A2UI v1.0 reducer and data binding, cut down from Roer's own
// (src/generative-ui/apply.ts, evaluate.ts) to what the pane draws. Pure:
// every function takes the surfaces and gives back new ones.

import type { RoerUiComponent, RoerUiSurface, RoerUiSurfaces } from '../types'

export const EMPTY: RoerUiSurfaces = { order: [], bySurface: {} }

type Message = Record<string, unknown>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const KINDS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']

/** Applies one message, or says why it was refused. The checks are
 * isA2uiMessage's (src/generative-ui/schema.ts): a malformed message is
 * refused whole, never shown in part. */
export function apply(surfaces: RoerUiSurfaces, message: unknown): RoerUiSurfaces | string {
  if (!isRecord(message)) return 'a message is not an object'
  if (message.version !== 'v1.0') return `version is ${JSON.stringify(message.version)}, not "v1.0"`
  const kinds = Object.keys(message).filter(key => key !== 'version')
  if (kinds.length !== 1) return `a message carries exactly one of ${KINDS.join(', ')}, not ${kinds.length}`
  const kind = kinds[0] as string
  const body = (message as Message)[kind]
  if (!KINDS.includes(kind)) return `the message has none of ${KINDS.join(', ')} (it has ${kind})`
  if (!isRecord(body)) return `${kind} is not an object`
  const { surfaceId } = body
  if (typeof surfaceId !== 'string' || surfaceId === '') return `${kind} needs a surfaceId`

  if (kind === 'createSurface') {
    const { components, dataModel, sendDataModel } = body
    if (components !== undefined && !isComponentList(components)) return badComponents(kind)
    if (dataModel !== undefined && !isRecord(dataModel)) return 'createSurface.dataModel is not an object'
    const surface: RoerUiSurface = {
      components: indexed(components ?? []),
      dataModel: dataModel ?? {},
      sendDataModel: sendDataModel === true,
    }
    return {
      order: [...surfaces.order.filter(id => id !== surfaceId), surfaceId],
      bySurface: { ...surfaces.bySurface, [surfaceId]: surface },
    }
  }
  if (kind === 'deleteSurface') {
    const { [surfaceId]: _gone, ...bySurface } = surfaces.bySurface
    return { order: surfaces.order.filter(id => id !== surfaceId), bySurface }
  }

  const surface = own(surfaces.bySurface, surfaceId)
  if (!surface) return `${kind} names no surface on screen (${surfaceId})`
  if (kind === 'updateComponents') {
    if (!isComponentList(body.components)) return badComponents(kind)
    return put(surfaces, surfaceId, {
      ...surface,
      components: { ...surface.components, ...indexed(body.components) },
    })
  }
  // updateDataModel. `value` is required even when it is null, the deletion
  // sentinel: a message without one is malformed, not a delete.
  if (!('value' in body)) return 'updateDataModel needs a value (null deletes)'
  const { path, value } = body
  if (path !== undefined && typeof path !== 'string') return 'updateDataModel.path is not a string'
  return put(surfaces, surfaceId, { ...surface, dataModel: setAt(surface.dataModel, path ?? '', value) })
}

const badComponents = (kind: string) => `${kind}.components is not a list of { id, component } entries`

function isComponentList(list: unknown): list is RoerUiComponent[] {
  return (
    Array.isArray(list) &&
    list.every(one => isRecord(one) && typeof one.id === 'string' && typeof one.component === 'string')
  )
}

function put(surfaces: RoerUiSurfaces, id: string, surface: RoerUiSurface): RoerUiSurfaces {
  return { ...surfaces, bySurface: { ...surfaces.bySurface, [id]: surface } }
}

/** Components by id. From entries, so every wire id is data: assigning
 * `out['__proto__']` would set the index's prototype instead of an entry. */
const indexed = (list: RoerUiComponent[]): Record<string, RoerUiComponent> =>
  Object.fromEntries(list.map(one => [one.id, one]))

/** `record[key]` when it is the record's own, never something inherited: a
 * wire id like `__proto__` or `toString` names nothing unless it was sent. */
export const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

/** A pointer made absolute: relative ones (no leading `/`) hang off `scope`,
 * the current template item. */
export function absolute(scope: string, path: string): string {
  if (path.startsWith('/')) return path
  return path === '' ? scope : `${scope}/${path}`
}

/** Keys that would reach an object's prototype rather than its own data. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

/** A pointer's unescaped segments. The leading `/` is optional: a relative
 * pointer (`title`) names the same member as `/title`. */
const tokens = (pointer: string): string[] =>
  pointer === ''
    ? []
    : (pointer.startsWith('/') ? pointer.slice(1) : pointer).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))

export function getAt(model: unknown, pointer: string): unknown {
  let at = model
  for (const token of tokens(pointer)) {
    if (FORBIDDEN.has(token) || typeof at !== 'object' || at === null) return undefined
    if (!Object.prototype.hasOwnProperty.call(at, token)) return undefined
    at = (at as Record<string, unknown>)[token]
  }
  return at
}

/** Writes `value` at `pointer`, copying on the way down; `null` (or
 * `undefined`) deletes, as updateDataModel defines it. As writePointer in
 * src/generative-ui/schema.ts. */
export function setAt(model: Record<string, unknown>, pointer: string, value: unknown): Record<string, unknown> {
  const path = tokens(pointer)
  if (path.length === 0) return isRecord(value) ? value : {}
  if (path.some(token => FORBIDDEN.has(token))) return model
  return writeAt(model, path, value) as Record<string, unknown>
}

function writeAt(at: unknown, [head, ...rest]: string[], value: unknown): unknown {
  const token = head as string
  const remove = value === null || value === undefined
  if (Array.isArray(at)) {
    const index = token === '-' ? at.length : Number(token)
    if (!Number.isInteger(index) || index < 0) return at
    // Deleting through a parent that isn't there leaves the model alone.
    if (rest.length > 0 && remove && index >= at.length) return at
    const copy = [...at]
    if (rest.length > 0) copy[index] = writeAt(copy[index], rest, value)
    else if (remove) copy.splice(index, 1)
    else copy[index] = value
    return copy
  }
  const base = isRecord(at) ? at : {}
  if (rest.length > 0) {
    if (remove && !Object.prototype.hasOwnProperty.call(base, token)) return at
    return { ...base, [token]: writeAt(base[token], rest, value) }
  }
  if (remove) {
    const { [token]: _gone, ...kept } = base
    return kept
  }
  return { ...base, [token]: value }
}

/** A dynamic value: a literal, or `{ path }` read from the data model.
 * Function calls are not evaluated in the pane yet. */
export function resolve(value: unknown, model: unknown, scope: string): unknown {
  if (isRecord(value) && typeof value.path === 'string') return getAt(model, absolute(scope, value.path))
  if (isRecord(value) && typeof value.call === 'string') return undefined
  return value
}

/** An action's context with each value resolved. From entries, as Roer's
 * panel builds it: assigning a `__proto__` key would set the object's
 * prototype and drop that value from the action. */
export const contextOf = (context: unknown, model: unknown, scope: string): Record<string, unknown> =>
  isRecord(context)
    ? Object.fromEntries(Object.entries(context).map(([name, value]) => [name, resolve(value, model, scope)]))
    : {}

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
