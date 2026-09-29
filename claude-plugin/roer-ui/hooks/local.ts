// What the pane does on its own, with no turn of the model's: Roer-only
// additions to A2UI v1.0, none of them in Roer's panel yet.
//
// - A `loadData` message fills a data-model path from a command's output or
//   a file, so the model names where data comes from instead of writing it.
// - A Button's `action.local` loads data and opens another surface when it is
//   pressed; `action.event`, beside it or not, still reaches the model.
// - A surface created with `hidden: true` is kept but not drawn until a
//   press opens it.
//
// Every command runs as the model's own Bash calls do, under the person's
// permissions: what their rules and mode allow runs at once, what needs asking
// opens the permission dialog, what they deny is refused (`runPermitted`).
//
// Pure but for `runPermitted` and `fetchLoad`, which reach the host through
// closures register.tsx makes over `$`.

import type { RoerUiSurfaces } from '../types'
import { absolute, own, resolve } from './a2ui'

/** Where a load's value comes from: a command's standard output (argv; a
 * file is `cat` of it, so the same permissions decide), or, in a press, a
 * value off the pressed item. */
export type LoadSource = { run: string[] } | { value: unknown }

export type Load = LoadSource & { surfaceId: string; path: string; as: 'text' | 'json' }

export type LocalAction = { loads: Load[]; open?: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why a wire value did not resolve to what a load needs: what it came to,
 * and for a binding, the pointer it read. Inside a template a pointer with
 * a leading `/` reads the surface's root, not the item: said when that is
 * the likely slip. */
function unlike(wire: unknown, got: unknown, scope: string, wanted: string): string {
  const came = got === undefined ? 'nothing' : got === null ? 'null' : Array.isArray(got) ? 'a list' : `a ${typeof got}`
  const path = isRecord(wire) && typeof wire.path === 'string' ? wire.path : undefined
  if (path === undefined) return `is ${came}, not ${wanted}`
  const slip = scope !== '' && path.startsWith('/') ? `; inside a template, "${path.slice(1)}" is the item's own` : ''
  return `{ "path": ${JSON.stringify(path)} } found ${came} at ${absolute(scope, path)}, not ${wanted}${slip}`
}

/** An id, a number or a path, as a bound argument must be: nothing a shell
 * or a command would read as more, and no leading `-` to be an option. */
const isToken = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^[\w@%+=:,./~#-]+$/.test(v) && !v.startsWith('-'))

/** A load off the wire, each dynamic value resolved against `model` at
 * `scope`, or why it is malformed. `surfaceId` is the load's own, else
 * `fallback`. `value` is offered only where `allowValue` (a press: in a
 * message, updateDataModel says it). */
export function readLoad(
  wire: unknown,
  model: unknown,
  scope: string,
  fallback: string | undefined,
  allowValue: boolean,
): Load | string {
  if (!isRecord(wire)) return 'a load is not an object'
  const surfaceId = wire.surfaceId === undefined ? fallback : wire.surfaceId
  if (typeof surfaceId !== 'string' || surfaceId === '') return 'a load needs a surfaceId'
  if (typeof wire.path !== 'string') return 'a load needs a path'
  const as = wire.as ?? 'text'
  if (as !== 'text' && as !== 'json') return `a load's as is ${JSON.stringify(as)}, not "text" or "json"`
  const sources = ['run', 'file', ...(allowValue ? ['value'] : [])].filter(key => key in wire)
  if (sources.length !== 1) return `a load carries exactly one of ${allowValue ? 'run, file, value' : 'run, file'}`
  const base = { surfaceId, path: wire.path, as } as const
  if ('run' in wire) {
    if (!Array.isArray(wire.run) || wire.run.length === 0) return 'a load\'s run is not a non-empty argv list'
    if (typeof wire.run[0] !== 'string') return 'a load\'s command is written out, never bound to the data model'
    const argv = wire.run.map(arg => resolve(arg, model, scope))
    // A number off the data model (a PR's number) is an argument as well.
    const bad = argv.findIndex(arg => typeof arg !== 'string' && typeof arg !== 'number')
    if (bad >= 0) return `argument ${bad + 1} of a load's run ${unlike(wire.run[bad], argv[bad], scope, 'a string or a number')}`
    // What comes off the data model may have come from anywhere (a PR's
    // body, a page), so it may be an id, a number or a path, never an option
    // or text: a model's `['sh', '-c', { path: '/body' }]` runs nothing.
    const loose = wire.run.findIndex((arg, n) => typeof arg !== 'string' && !isToken(argv[n]))
    if (loose >= 0) return `argument ${loose + 1} of a load's run is bound to ${JSON.stringify(String(argv[loose]).slice(0, 40))}, not an id, a number or a path`
    const run = argv.map(String)
    if (run[0] === '') return 'a load\'s run names no command'
    return { ...base, run }
  }
  if ('file' in wire) {
    const file = resolve(wire.file, model, scope)
    if (typeof file !== 'string' || file === '') return `a load's file ${unlike(wire.file, file, scope, 'a path')}`
    return { ...base, run: ['cat', '--', file] }
  }
  return { ...base, value: resolve(wire.value, model, scope) }
}

/** A Button's `action.local`, resolved as `readLoad` does, or undefined when
 * the action has none. A load names the surface it opens unless it says
 * otherwise, else the button's own. */
export function readLocal(action: unknown, model: unknown, scope: string, from: string): LocalAction | string | undefined {
  if (!isRecord(action) || action.local === undefined) return undefined
  const local = action.local
  if (!isRecord(local)) return 'action.local is not an object'
  const open = local.open
  if (open !== undefined && (typeof open !== 'string' || open === '')) return 'action.local.open is not a surfaceId'
  const wires = local.load ?? []
  if (!Array.isArray(wires)) return 'action.local.load is not a list'
  const loads: Load[] = []
  for (const wire of wires) {
    const load = readLoad(wire, model, scope, open ?? from, true)
    if (typeof load === 'string') return load
    loads.push(load)
  }
  return { loads, ...(open === undefined ? {} : { open }) }
}

/** A command's or a file's text as the load asked for it, or why it could
 * not be read that way. */
export function parsed(load: Load, text: string): { value: unknown } | string {
  if (load.as === 'text') return { value: text }
  try {
    return { value: JSON.parse(text) }
  } catch {
    return `${describe(load)} did not print JSON`
  }
}

/** A load, as a person reading an error would name it. */
export const describe = (load: Load): string => ('run' in load ? `\`${shellCommand(load.run)}\`` : load.path)

/** At most `limit` characters of a command's complaint, on one line. */
export const brief = (text: string, limit = 300): string => {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** The surfaces with `to` drawn in place of `from`, the surface pressed:
 * `from` is kept, hidden, to be opened again. Nothing changes when `to`
 * names no surface. */
export function opened(surfaces: RoerUiSurfaces, from: string, to: string): RoerUiSurfaces {
  const target = own(surfaces.bySurface, to)
  if (target === undefined) return surfaces
  const source = own(surfaces.bySurface, from)
  const bySurface = { ...surfaces.bySurface, [to]: { ...target, hidden: false } }
  if (source !== undefined && from !== to) bySurface[from] = { ...source, hidden: true }
  return { ...surfaces, bySurface }
}

/** A `loadData` message read as a load, or why it is malformed; undefined
 * for any other message. */
export function readLoadData(message: unknown): Load | string | undefined {
  if (!isRecord(message) || !('loadData' in message)) return undefined
  if (message.version !== 'v1.0') return `version is ${JSON.stringify(message.version)}, not "v1.0"`
  if (Object.keys(message).length !== 2) return 'a loadData message carries nothing else'
  return readLoad(message.loadData, {}, '', undefined, false)
}

/** `argv` as one shell command line that runs exactly it: what the
 * permission rules read (they are written over Bash command lines) and what
 * the dialog shows. */
export const shellCommand = (argv: string[]): string =>
  argv.map(arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ')

type Ran = { exitCode: number; stdout: string; stderr: string }

/** How a command reaches the host, as closures over the hook's `$` (the
 * engine wants `$` spelled where it is called). */
export type RunIo = {
  /** The session's permission decision for a Bash command line. */
  check: (command: string) => Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string }>
  /** Runs argv at once, whole output. */
  run: (argv: string[]) => Promise<Ran>
  /** Runs a command line as a Bash tool call: the permission dialog, hooks
   * and classifier on the way. */
  bash: (command: string) => Promise<BashRan>
  /** A file's whole text: where the Bash tool kept output too long to hand back. */
  read: (path: string) => Promise<string>
}

/** What a Bash tool call answered, as `runPermitted` reads it. */
export type BashRan = { deny?: string; isError?: boolean; stdout?: unknown; persisted?: unknown; text?: string }

/** A Bash tool call's answer, from `$.tool.call`'s result. */
export const bashRan = (ran: { deny?: string; isError?: boolean; result?: unknown; text?: string }): BashRan => {
  const result = ran.result as { stdout?: unknown; persistedOutputPath?: unknown } | undefined
  return { deny: ran.deny, isError: ran.isError, stdout: result?.stdout, persisted: result?.persistedOutputPath, text: ran.text }
}

/** Runs argv as the person's permissions say. An allowed command runs
 * directly, so its output comes whole (a Bash tool's is cut for the model);
 * one that needs asking goes through the Bash tool, whose dialog asks; a
 * denied one throws. */
export async function runPermitted(argv: string[], io: RunIo): Promise<Ran> {
  const command = shellCommand(argv)
  const { decision, reason } = await io.check(command)
  if (decision === 'deny') throw new Error(`denied by your permissions${reason ? ` (${reason})` : ''}`)
  if (decision === 'allow') return io.run(argv)
  const ran = await io.bash(command)
  if (ran.deny !== undefined) throw new Error(`not run: ${ran.deny}`)
  if (ran.isError) return { exitCode: 1, stdout: '', stderr: ran.text ?? '' }
  // Output too long for the model is kept whole in a file, and `stdout` is
  // only its start: a diff's first hunks, half a JSON list.
  if (typeof ran.persisted === 'string' && ran.persisted !== '') return { exitCode: 0, stdout: await io.read(ran.persisted), stderr: '' }
  return { exitCode: 0, stdout: typeof ran.stdout === 'string' ? ran.stdout : (ran.text ?? ''), stderr: '' }
}

/** A load's value, or why it could not be had. Never throws. */
export async function fetchLoad(load: Load, io: RunIo): Promise<{ value: unknown } | string> {
  if ('value' in load) return { value: load.value }
  try {
    const ran = await runPermitted(load.run, io)
    if (ran.exitCode !== 0) return `${describe(load)} exited ${ran.exitCode}: ${brief(ran.stderr || ran.stdout)}`
    return parsed(load, ran.stdout)
  } catch (err) {
    return `${describe(load)}: ${brief(err instanceof Error ? err.message : String(err))}`
  }
}
