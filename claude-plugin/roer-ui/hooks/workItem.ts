// What a work item's detail view is made of, and how each piece is read off
// the wire: Roer's own readers (src/generative-ui/workItem.ts), and the
// status and progress rules its cards use (GenerativeSurface.tsx). Every
// reader keeps what is shaped right and drops the rest, one element at a
// time: a typo in one finding costs that finding, not the whole view.

export type Requirement = { id: string; text: string; met: boolean }
export type SourceRef = { kind: 'ticket' | 'slack' | 'doc' | 'file'; label: string; url?: string; path?: string }
export type Note = { path: string; text: string; line?: number; side?: 'old' }
export type ChangeRef = { id: string; title: string; patch: string; notes?: Note[] }
export type FindingState = 'open' | 'resolved' | 'dismissed'
export type Finding = {
  id: string
  severity: 'info' | 'warn' | 'error'
  text: string
  at?: { changeId: string; path: string; line: number; side?: 'old' }
  state: FindingState
}
export type DiagramThread = { id: string; node: string; author: string; text: string; replies: { author: string; text: string }[]; state: 'open' | 'resolved' }
export type Comment = { id: string; author: string; text: string; at?: string }
export type Decision = { id: string; question: string; options: { label: string; value: string }[]; answer?: string }

type Wire = Record<string, unknown>

const isWire = (v: unknown): v is Wire => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const each = <T>(v: unknown, read: (w: Wire) => T | undefined): T[] =>
  Array.isArray(v) ? v.flatMap(w => (isWire(w) ? (read(w) ?? []) : [])) : []

export const readRequirements = (v: unknown): Requirement[] =>
  each(v, w => {
    const id = str(w.id)
    const text = str(w.text)
    return id && text ? { id, text, met: w.met === true } : undefined
  })

const SOURCE_KINDS = ['ticket', 'slack', 'doc', 'file'] as const

export const readSources = (v: unknown): SourceRef[] =>
  each(v, w => {
    const label = str(w.label)
    if (!label) return undefined
    const kind = SOURCE_KINDS.find(k => k === w.kind) ?? (str(w.path) ? 'file' : 'doc')
    const url = str(w.url)
    const path = str(w.path)
    return { kind, label, ...(url ? { url } : {}), ...(path ? { path } : {}) }
  })

export const readComments = (v: unknown): Comment[] =>
  each(v, w => {
    const id = str(w.id)
    const author = str(w.author)
    const text = str(w.text)
    if (!id || !author || !text) return undefined
    const at = str(w.at)
    return { id, author, text, ...(at ? { at } : {}) }
  })

export const readDiagramThreads = (v: unknown): DiagramThread[] =>
  each(v, w => {
    const id = str(w.id)
    const node = str(w.node)
    const text = str(w.text)
    if (!id || !node || !text) return undefined
    const replies = each(w.replies, r => {
      const author = str(r.author)
      const said = str(r.text)
      return author !== undefined && said !== undefined ? { author, text: said } : undefined
    })
    return { id, node, author: str(w.author) ?? '', text, replies, state: w.state === 'resolved' ? 'resolved' : 'open' }
  })

export const readNotes = (v: unknown): Note[] =>
  each(v, w => {
    const path = str(w.path)
    const text = str(w.text)
    if (!path || !text) return undefined
    return {
      path,
      text,
      ...(typeof w.line === 'number' ? { line: w.line } : {}),
      ...(w.side === 'old' ? { side: 'old' as const } : {}),
    }
  })

export const readChanges = (v: unknown): ChangeRef[] =>
  each(v, w => {
    const id = str(w.id)
    const patch = str(w.patch)
    if (!id || patch === undefined) return undefined
    const notes = readNotes(w.notes)
    return { id, title: str(w.title) ?? id, patch, ...(notes.length > 0 ? { notes } : {}) }
  })

const SEVERITIES = ['info', 'warn', 'error'] as const
const FINDING_STATES = ['open', 'resolved', 'dismissed'] as const

export const readFindings = (v: unknown): Finding[] =>
  each(v, w => {
    const id = str(w.id)
    const text = str(w.text)
    if (!id || !text) return undefined
    const at = isWire(w.at) ? w.at : undefined
    const changeId = str(at?.changeId)
    const path = str(at?.path)
    const line = at?.line
    return {
      id,
      text,
      severity: SEVERITIES.find(s => s === w.severity) ?? 'info',
      state: FINDING_STATES.find(s => s === w.state) ?? 'open',
      ...(changeId && path && typeof line === 'number'
        ? { at: { changeId, path, line, ...(at?.side === 'old' ? { side: 'old' as const } : {}) } }
        : {}),
    }
  })

export const readDecisions = (v: unknown): Decision[] =>
  each(v, w => {
    const id = str(w.id)
    const question = str(w.question)
    if (!id || !question) return undefined
    const options = each(w.options, o => {
      const value = str(o.value)
      return value === undefined ? undefined : { value, label: str(o.label) ?? value }
    })
    const answer = str(w.answer)
    return { id, question, options, ...(answer ? { answer } : {}) }
  })

/** How each tracker is named on an item; anything else is shown as sent. */
export const SOURCE_NAMES: Record<string, string> = {
  github: 'GitHub',
  youtrack: 'YouTrack',
  notion: 'Notion',
  jira: 'Jira',
  personal: 'Personal',
}

export type Tone = 'done' | 'doing' | 'blocked' | 'failed' | 'todo'

/** A status, by what it means for the work rather than what a tracker calls
 * it: every tracker spells "finished" its own way. */
export function statusTone(status: string): Tone {
  const s = status.toLowerCase().replace(/[\s_-]+/g, ' ').trim()
  if (
    ['done', 'closed', 'fixed', 'resolved', 'completed', 'merged', 'verified', 'success', 'succeeded', 'passed', 'deployed'].includes(s)
  )
    return 'done'
  if (['doing', 'in progress', 'in review', 'active', 'started', 'review', 'working', 'running'].includes(s)) return 'doing'
  if (['blocked', 'on hold', 'waiting'].includes(s)) return 'blocked'
  if (['failed', 'failure', 'error', 'errored', 'broken'].includes(s)) return 'failed'
  return 'todo'
}

/** Only a number or a numeric string counts as progress; anything else,
 * `false`, `null` and `" "` included, draws no bar at all. */
export function progressValue(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined
}

/** A value the person set in the pane, shown only while the agent's value is
 * still the one it replaced: the agent resending the old item does not undo
 * the person's click, and the agent sending anything else wins. As
 * `useLocal` in Roer's WorkItemDetail. */
export type Local = { base: unknown; value: unknown }

export function shownValue<T>(local: unknown, current: T): T {
  if (typeof local !== 'object' || local === null || !('value' in local)) return current
  const { base, value } = local as Local
  return same(base, current) ? (value as T) : current
}

/** Plugin state keeps no `undefined`, so a missing value is stored as `null`
 * and the two compare equal. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
