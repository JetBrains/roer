// The work item Roer keeps for this session's repository and branch, drawn in
// the pane without a turn of Claude's: Roer's work-item extension keeps every
// item in one file, `$ROER_HOME/extension-data/work-item/items.json`, filed
// under `root\0branch` (its server.ts), and its tab in Roer reads the same
// file. `/work-item` draws it as a WorkItem in detail, with the branch's
// uncommitted changes as its one change, and reads both again on a timer.

import type { EngineInterface } from 'claude-code'

/** The surface the item is drawn on. */
export const WORK_ITEM_SURFACE = 'work-item'

/** How often the file and the changes are read again. Roer's own tab polls the file as often. */
export const WORK_ITEM_EVERY_MS = 2000

/** One id for the uncommitted changes, which a finding's `at` names. */
const CHANGE_ID = 'uncommitted'

type Wire = Record<string, unknown>
const isWire = (v: unknown): v is Wire => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What is read: where the session is, the item filed for it, its changes. */
export type Found =
  | { kind: 'item'; root: string; branch: string; item: Wire; patch: string }
  | { kind: 'none'; root: string; branch: string }
  | { kind: 'problem'; text: string }

async function line($: EngineInterface, argv: string[], cwd?: string): Promise<string | null> {
  const ran = await $.process.run(argv, cwd ? { cwd } : undefined).catch(() => null)
  if (!ran || ran.exitCode !== 0) return null
  return ran.stdout.trim() || null
}

/** Where Roer keeps its data, as its CLI finds it: `$ROER_HOME`, else `~/.roer`. */
async function roerHome($: EngineInterface): Promise<string | null> {
  const own = await line($, ['printenv', 'ROER_HOME'])
  if (own) return own
  const home = await line($, ['printenv', 'HOME'])
  return home ? `${home}/.roer` : null
}

export async function findWorkItem($: EngineInterface): Promise<Found> {
  const cwd = await $.session.cwd()
  const root = await line($, ['git', 'rev-parse', '--show-toplevel'], cwd)
  if (!root) return { kind: 'problem', text: `${cwd} is not in a git repository.` }
  const branch = (await line($, ['git', 'branch', '--show-current'], root)) ?? 'HEAD'
  const home = await roerHome($)
  if (!home) return { kind: 'problem', text: 'Cannot tell where Roer keeps its data (no HOME).' }
  let items: unknown
  try {
    items = JSON.parse(await $.fs.read(`${home}/extension-data/work-item/items.json`))
  } catch {
    return { kind: 'none', root, branch }
  }
  const entry = isWire(items) ? items[`${root}\u0000${branch}`] : undefined
  const item = isWire(entry) && isWire(entry.item) ? entry.item : undefined
  if (!item) return { kind: 'none', root, branch }
  const diff = await $.process.run(['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD'], { cwd: root }).catch(() => null)
  return { kind: 'item', root, branch, item, patch: diff && diff.exitCode === 0 ? diff.stdout : '' }
}

/** The item as the catalog's WorkItem takes it: a finding's `at` names the one change, the uncommitted one. */
export function asCatalogItem(found: Extract<Found, { kind: 'item' }>): Wire {
  const findings = Array.isArray(found.item.findings) ? found.item.findings : []
  return {
    ...found.item,
    findings: findings.map(one => {
      if (!isWire(one) || !isWire(one.at)) return one
      return { ...one, at: { ...one.at, changeId: CHANGE_ID } }
    }),
    changes: found.patch ? [{ id: CHANGE_ID, title: `Uncommitted on ${found.branch}`, patch: found.patch }] : [],
  }
}

/** The messages that draw what was found on the work-item surface, whole. */
export function workItemMessages(found: Found): unknown[] {
  const where = found.kind === 'problem' ? '' : `${found.root.split('/').pop()} · ${found.branch}`
  const components =
    found.kind === 'item'
      ? [
          {
            id: 'root',
            component: 'WorkItem',
            variant: 'detail',
            key: { path: '/item/key' },
            source: { path: '/item/source' },
            title: { path: '/item/title' },
            status: { path: '/item/status' },
            goal: { path: '/item/goal' },
            requirements: { path: '/item/requirements' },
            decisions: { path: '/item/decisions' },
            findings: { path: '/item/findings' },
            sources: { path: '/item/sources' },
            comments: { path: '/item/comments' },
            changes: { path: '/item/changes' },
            footer: where,
          },
        ]
      : [
          {
            id: 'root',
            component: 'EmptyState',
            text: found.kind === 'none' ? 'No work item for this branch yet' : 'No work item to show',
            detail:
              found.kind === 'none'
                ? `${where}: an agent shows one with Roer's work-item__show, and it appears here.`
                : found.text,
          },
        ]
  return [
    {
      version: 'v1.0',
      createSurface: {
        surfaceId: WORK_ITEM_SURFACE,
        components,
        dataModel: found.kind === 'item' ? { item: asCatalogItem(found) } : {},
      },
    },
  ]
}
