# Roer Extensions API — draft

Status: **draft / RFC**. Nothing here is implemented yet.

## Goal

Customize Roer's UI on the fly with extensions an agent *generates*, instead
of features we hand-code. The test case: the Changes tab. Today it is
`DiffBrowserView.tsx` wired into `App.tsx` by hand. We should be able to
generate it, register it as an extension, and have it behave the same way:
live when files change, working keyboard shortcuts, with no agent running
once it's registered.

## What exists today, and what's missing

Roer already has an A2UI prototype:

| Piece | Where |
| --- | --- |
| Wire format (`surfaceUpdate` / `dataModelUpdate` / `beginRendering`) | `src/generative-ui/schema.ts` |
| Reducer | `src/generative-ui/apply.ts` |
| Trusted, closed catalog renderer | `src/generative-ui/GenerativeSurface.tsx` |
| Terminal → app channel, app → terminal actions | `src-tauri/src/plugin_ui.rs`, `roer plugin-ui[-actions]` |
| Agent entry points | `roer mcp`: `show_ui`, `read_ui_actions`, `save_ui`, `load_ui` |
| Persistence | `.roer/plugin-ui/bundles/<name>/` |

That works for *agent-driven, ephemeral* UI: the agent pushes data, and clicks
are reported back to the agent. A Changes tab needs four more things:

1. **The host as a data source.** The data (git status, diffs, branches) has
   to come from Roer itself and stay fresh without the agent.
2. **Data binding and templating.** Today every `Text` is a literal and every
   list is spelled out by hand. A file list needs "one row per item in
   `changes.files`".
3. **Rich host components.** A syntax-highlighted diff can't be built out of
   `Text`s. It has to be a trusted catalog component that wraps `DiffPane`.
4. **Contribution points.** An extension has to be able to become a *stage
   tab*, not just fill the side panel.

The principle stays the same: **an extension is data, never code.** It can
only compose trusted components, read from allowlisted host queries, and call
allowlisted host commands.

---

## 1. The extension manifest

An extension is one directory holding an `extension.json`:

```
<project>/.roer/extensions/<id>/extension.json   # project-scoped (checked in or not)
~/.roer/extensions/<id>/extension.json           # user-scoped, every project
```

```ts
interface ExtensionManifest {
  apiVersion: 1;
  id: string;                       // [a-z0-9-]+, unique per scope; project wins over user
  name: string;                     // shown in the tab strip / extension list
  description?: string;
  /** How it was made, like bundles' `prompt` — lets an agent regenerate or tweak it. */
  generatedFrom?: { prompt: string; model?: string; at?: string };

  /** What the extension is allowed to touch. Checked when it loads, and shown to the user. */
  capabilities: Capability[];

  /** Where it shows up in the UI. */
  contributes: Contribution[];

  /** The A2UI surfaces it draws: the same `surfaceUpdate` shape as today, plus bindings (§3). */
  surfaces: Record<SurfaceId, { root: ComponentId; components: Component[] }>;

  /** Initial data model per surface, the same shape as a `dataModelUpdate` patch. */
  initialData?: Record<SurfaceId, DataModel>;

  /** Host queries that feed the data model (§2). */
  sources?: Record<SourceId, Source>;

  /** Named actions that components trigger (§4). */
  actions?: Record<ActionId, Action>;
}

type Capability =
  | "git:read" | "git:write"        // status/diff/log | stage/unstage/discard
  | "github:read"                   // gh pr view, checks…
  | "files:read"                    // read files under the session root
  | "stage:open"                    // open file tabs, switch tabs
  | "agent:report";                 // report actions to the pane's agent (today's behaviour)
```

### Contribution points

```ts
type Contribution =
  | {
      kind: "stageTab";
      id: string;
      title: string | Bound;          // bound so it can say "Changes (3)"
      surface: SurfaceId;
      order?: number;                 // position in the strip, after the built-ins by default
      /** Take over a built-in tab's slot. The built-in stays available as a fallback. */
      replaces?: "changes" | "pullRequest";
      badge?: Bound;                  // e.g. a dot when a PR check fails
      keybindings?: Keybinding[];     // only active while this tab is on top
    }
  | {
      kind: "sidePanel";              // today's Generative UI panel, now multi-surface
      id: string;
      title: string;
      surface: SurfaceId;
    };

interface Keybinding {
  key: string;                        // parsed by lib/keys.ts, e.g. "mod+shift+ArrowDown"
  action: ActionId;
}
```

Later possibilities, out of scope for v1: `statusItem`, `command` (command
palette), `fileDecoration`.

---

## 2. Sources: the host as the "agent"

A **source** is a named, read-only host query. The host runs it, writes the
result into the surface's data model at `into`, and runs it again when its
triggers fire. This is what lets a generated tab stay live without an agent.

```ts
interface Source {
  query: QueryName;
  /** Arguments are literals or bound to the data model. A change to a bound arg re-runs the query. */
  args?: Record<string, Literal | Bound>;
  into: string;                       // data-model path, e.g. "changes"
  refreshOn?: Trigger[];
  /** Skip the query while any required arg is unset (e.g. no file selected yet). */
  requires?: string[];
}

type Trigger =
  | "mount"                           // first time the surface is shown
  | "activate"                        // every time its tab comes on top
  | "files.changed"                   // the existing worktree watch (onFilesChanged)
  | "session.cwd"                     // a `cd` inside the pane
  | { every: number };                // polling in seconds, clamped to at least 5

/** Loading and error state lives next to the data, so the UI can bind to it. */
// into = "changes" → "changes" (value), "changes$loading" (bool), "changes$error" (string | null)
```

### Query registry, v1

These are thin wrappers over Tauri commands that already exist, so there's
nothing new on the Rust side:

| Query | Args | Result | Capability | Backed by |
| --- | --- | --- | --- | --- |
| `session.info` | — | `{ cwd, pane, root, branch }` | — | `resolveDir`, `git_root` |
| `git.changes` | — | `Changes` | `git:read` | `git_changes` |
| `git.diff` | `path`, `untracked` | `ParsedDiff` | `git:read` | `git_diff` + `lib/diff.ts` |
| `git.branches` | — | `string[]` | `git:read` | `git_branches` |
| `git.branchCommits` | `branch`, `base` | `Commit[]` | `git:read` | `git_branch_commits` |
| `git.commitFiles` | `commit` | `FileChange[]` | `git:read` | `git_commit_files` |
| `git.commitDiff` | `commit`, `path` | `ParsedDiff` | `git:read` | `git_commit_diff` |
| `github.pr` | — | PR summary + checks | `github:read` | `gh.rs` |
| `files.read` | `path` | `{ text, lang }` | `files:read` | `files.rs` |

Results are plain JSON, and derived fields get added host-side so extensions
never need an expression language: `FileChange` gains `status`
(`statusLetter`), `kind` (`changeKind`), `untracked`, `staged`, and `name`
(`baseName`).

The registry also serves as the generation contract. `describe_host` (§6)
returns this table as a JSON schema, so the model generates against what
actually exists.

---

## 3. Catalog additions

### Bound values

Any string, number, or boolean prop may be a binding instead of a literal:

```ts
type Bound =
  | { path: string }                  // absolute data-model path: "selected.path"
  | { item: string }                  // relative to the current template item: "path"
  | { format: string; args: Record<string, Bound> }; // "{added}+ / {deleted}−" (interpolation only, no logic)
```

Every component also gets `visibleIf?: Bound` (truthy check) and
`emptyText?: string` (for templated containers with zero items).

### Templated children

Instead of `children: ComponentId[]`, containers can take a template. This is
A2UI's `template` + `dataBinding`, using Roer's dot paths:

```json
{ "id": "fileList", "type": "List",
  "children": { "template": { "componentId": "fileRow", "dataBinding": "changes.files" } } }
```

Inside `fileRow` and its descendants, `{ "item": "…" }` resolves against the
current array element. `{ "item": "$index" }` gives its index.

### New host components

These are trusted and rendered by existing React code:

| Component | Props | Renders |
| --- | --- | --- |
| `DiffView` | `diff: Bound` (a `ParsedDiff`), `path?: Bound`, `mode?: "unified"` | `DiffPane`, with highlighting and theme |
| `FileRow` | `path: Bound`, `status?: Bound`, `added?`, `deleted?`, `selected?: Bound`, `action` | The row style Changes uses today |
| `SplitPane` | `start: id`, `end: id`, `initial?: number`, `persistKey?` | A resizable two-pane layout |
| `Select` | `options: Bound` (array of strings or `{label,value}`), `valuePath` | Branch pickers |
| `Badge` | `text: Bound`, `tone?: "neutral" \| "added" \| "deleted" \| "warning"` | A status letter or count |
| `Spinner` / `ErrorText` | `visibleIf`, `text?` | Loading and error for `…$loading` / `…$error` |
| `CodeBlock` | `text: Bound`, `lang?: Bound` | `CodeLine`-based read-only code |

The rules for existing components stay in place: unknown types render as a
visible placeholder, and cycles are cut.

---

## 4. Actions

Today, `Button.action` is a string that gets reported to the agent. Now it
names an entry in `actions`, which is a short list of **steps**. There are no
loops, no conditionals, and no expressions, only these:

```ts
type Action = { steps: Step[]; context?: Record<string, Bound> };

type Step =
  | { op: "set"; path: string; value: Literal | Bound }        // write the data model
  | { op: "refresh"; source: SourceId }                        // re-run a query now
  | { op: "select"; list: string; path: string; delta: 1 | -1 } // move a selection through an array (for next/prev keys)
  | { op: "host"; command: HostCommand; args?: Record<string, Literal | Bound> }
  | { op: "agent" };                                           // today's report_plugin_ui_action, with `context`

type HostCommand =
  | "stage.openFile"      // { path, line? }            — stage:open
  | "stage.activate"      // { tab }                    — stage:open
  | "git.stage"           // { path }                   — git:write
  | "git.unstage"         // { path }                   — git:write
  | "clipboard.copy";     // { text }
```

`{ item: … }` bindings inside an action resolve against the item of the
component that fired it. That's how a click on a templated row knows which
file it was.

When an action starts a step its manifest didn't declare the capability for,
the host rejects it before running anything, and the tab shows an error card.

---

## 5. Host-side registry (TypeScript)

This sits in `src/extensions/` and replaces the hard-coded tab buttons in
`App.tsx`. Built-in tabs register through the same path.

```ts
// src/extensions/registry.ts
export interface LoadedExtension {
  manifest: ExtensionManifest;
  scope: "project" | "user" | "session";   // "session" = registered live by an agent, not on disk
  status: "active" | "disabled" | { error: string };
}

export interface ExtensionRegistry {
  list(): readonly LoadedExtension[];
  get(id: string): LoadedExtension | undefined;
  /** Validates, checks capabilities (and asks the user if needed), then activates. Replaces any existing registration with the same id. */
  register(manifest: unknown, scope: LoadedExtension["scope"]): Promise<LoadedExtension>;
  unregister(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  /** The tab strip and panels re-render off this. */
  subscribe(listener: () => void): () => void;
}

// src/lib/tabs.ts — one new tab kind
export type StageTab =
  | { kind: "terminal" }
  | { kind: "changes" }
  | { kind: "pullRequest" }
  | { kind: "file"; root: string; path: string; line?: number }
  | { kind: "extension"; extension: string; contribution: string };
// tabId → `ext:<extension>/<contribution>`
```

**Runtime per (extension, pane).** Each mounted surface gets an
`ExtensionRuntime` that owns its `RenderState` (the existing reducer), runs
sources against *that* session's `cwd`/`pane`, and routes actions. It is
keyed by pane for the same reason `App.tsx` resets the generative panel when
the pane changes: state from one session must never act on another.

**Validation.** Checks run in `validateManifest(unknown): Result<ExtensionManifest, Issue[]>`
with path-precise issues such as `surfaces.main.components[4].children: unknown id "fileRow"`.
Agents get these issues back so they can repair the manifest themselves.

**Hot reload.** A `notify` watcher on both `extensions/` dirs, the same shape
as `watch_records`, re-registers an extension whenever its manifest changes.
The data model survives a reload when the surface id stays the same.

---

## 6. Registering: CLI and MCP

CLI, next to `roer plugin-ui`:

```
roer ext register [--user] <dir | ->   validate and install (stdin = manifest JSON)
roer ext register --session -          live-only, for iterating; gone on app restart
roer ext validate <dir | ->            print issues, exit 2 on error
roer ext list | remove <id> | enable <id> | disable <id>
```

MCP tools for `roer mcp`:

| Tool | Purpose |
| --- | --- |
| `describe_host` | The catalog, query registry, host commands, and capabilities as JSON schema. Generation starts here. |
| `register_extension` | `{ manifest, scope }` → `{ ok, issues[] }`. `scope: "session"` for drafts. |
| `get_extension` | Read back a manifest so it can be edited incrementally. |
| `remove_extension` | |
| `preview_extension` | Render into the side panel with live sources before registering it as a tab |

`show_ui`, `save_ui`, and `load_ui` stay. A saved bundle is just an
extension with one `sidePanel` contribution and no sources, and
`roer ext register` can import one.

**Trust.** An extension that asks only for read capabilities activates
immediately. The first registration of one that asks for `git:write` (or
changes its capability set) shows a confirmation that lists the capabilities
and `generatedFrom.prompt`. Extensions registered with project scope from a
freshly cloned repo start `disabled` until the user enables them.

---

## 7. Worked example: the Changes tab as an extension

This is the local-changes half of `DiffBrowserView`: a file list, the
selected file's diff, live refresh, and `mod+j`/`mod+k` to move between
files. The branch/commit browser is the same pattern with
`git.branchCommits`/`git.commitFiles` sources and two `Select`s.

```json
{
  "apiVersion": 1,
  "id": "changes",
  "name": "Changes",
  "generatedFrom": { "prompt": "A Changes tab: changed files on the left, diff of the selected one on the right." },
  "capabilities": ["git:read", "stage:open"],

  "contributes": [{
    "kind": "stageTab",
    "id": "main",
    "title": { "format": "Changes ({n})", "args": { "n": { "path": "changes.files.length" } } },
    "surface": "changes",
    "replaces": "changes",
    "keybindings": [
      { "key": "mod+j", "action": "next" },
      { "key": "mod+k", "action": "prev" },
      { "key": "Enter", "action": "open" }
    ]
  }],

  "sources": {
    "changes": { "query": "git.changes", "into": "changes",
                 "refreshOn": ["mount", "activate", "files.changed", "session.cwd"] },
    "diff": { "query": "git.diff",
              "args": { "path": { "path": "selected.path" }, "untracked": { "path": "selected.untracked" } },
              "requires": ["selected.path"], "into": "diff",
              "refreshOn": ["files.changed"] }
  },

  "actions": {
    "pick": { "steps": [{ "op": "set", "path": "selected", "value": { "item": "" } }] },
    "next": { "steps": [{ "op": "select", "list": "changes.files", "path": "selected", "delta": 1 }] },
    "prev": { "steps": [{ "op": "select", "list": "changes.files", "path": "selected", "delta": -1 }] },
    "open": { "steps": [{ "op": "host", "command": "stage.openFile", "args": { "path": { "path": "selected.path" } } }] }
  },

  "surfaces": {
    "changes": {
      "root": "split",
      "components": [
        { "id": "split", "type": "SplitPane", "start": "left", "end": "right", "initial": 320, "persistKey": "changes" },

        { "id": "left", "type": "Column", "children": ["branch", "loading", "error", "files"] },
        { "id": "branch", "type": "Text", "muted": true, "text": { "path": "changes.branch" } },
        { "id": "loading", "type": "Spinner", "visibleIf": { "path": "changes$loading" } },
        { "id": "error", "type": "ErrorText", "text": { "path": "changes$error" }, "visibleIf": { "path": "changes$error" } },
        { "id": "files", "type": "List", "emptyText": "No local changes",
          "children": { "template": { "componentId": "fileRow", "dataBinding": "changes.files" } } },
        { "id": "fileRow", "type": "FileRow", "action": "pick",
          "path": { "item": "path" }, "status": { "item": "status" },
          "added": { "item": "added" }, "deleted": { "item": "deleted" },
          "selected": { "format": "{a}", "args": { "a": { "item": "$selected" } } } },

        { "id": "right", "type": "Column", "children": ["pickHint", "diffView"] },
        { "id": "pickHint", "type": "Text", "muted": true, "text": "Select a file",
          "visibleIf": { "path": "selected$unset" } },
        { "id": "diffView", "type": "DiffView", "diff": { "path": "diff" }, "path": { "path": "selected.path" },
          "visibleIf": { "path": "selected.path" } }
      ]
    }
  }
}
```

The example exposed some gaps, which are marked as open questions below:
`changes.files.length`, `$selected`, and `selected$unset` are *derived paths*.
The minimum we'd need to support is `.length`, `$index`, `$selected`
(true when the item equals the value at the `selected` path of the action
that set it), and `$unset`.

---

## 8. Rollout

1. **Read-only tabs.** Bindings, templates, `sources` with `git.*` and
   `session.info`, `stageTab` contribution, `DiffView`/`FileRow`/`SplitPane`,
   `roer ext register --session`, and MCP `describe_host`/`register_extension`.
   Done when the manifest above renders next to the built-in Changes tab and
   stays live.
2. **Interaction.** Actions (`set`, `select`, `refresh`, `stage.*`),
   keybindings, on-disk scopes, and hot reload.
3. **Replacing built-ins.** `replaces`, the trust prompt and `git:write`,
   `github.pr`, and porting Pull Request as the second proof.
4. **Cleanup.** Move bundles onto extensions, and put the built-in tabs
   behind the registry.

## Open questions

- **Derived paths vs. host-side derivation.** The draft uses a few magic
  suffixes (`.length`, `$selected`, `$unset`). The alternative is to have
  sources emit everything precomputed (e.g. `changes.count`), which is
  simpler but pushes UI state into queries. Lean: a tiny fixed set of
  suffixes, and never a general expression language.
- **Large diffs.** Should `DiffView` fetch on its own (`root` + `path`
  props) instead of going through the data model, to avoid copying big
  strings through state? It's faster, but it makes a component
  capability-bearing.
- **Paths.** Roer uses dot paths today, while A2UI v0.8 uses slash paths. Do
  we align now, while there's only one consumer?
- **Agent + host together.** Can a stage-tab extension also take
  `dataModelUpdate`s from the pane's agent (e.g. "explain this diff" writes
  into `notes`)? Probably yes, scoped to that surface and the paths it
  declares as `agentWritable`.
- **Sharing.** Should project-scoped extensions be committed, or kept in
  `.roer/` and git-ignored like bundles? This affects the trust default.
