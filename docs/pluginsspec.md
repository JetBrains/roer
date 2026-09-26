# Roer Extensions API — draft

Status: **draft / RFC**. Nothing here is implemented yet.

## Goal

Customize Roer's UI on the fly with extensions an agent *generates*, instead
of features we hand-code. The author is an **end user talking to the agent in
their pane** ("make me a tab that…"). Roer developers porting the built-ins
are a secondary audience, and that comes later.

The proof is the **local-changes half of the Changes tab**: the worktree's
changed files and the selected file's diff. It has to be live when files
change, have working keyboard navigation, and run with no agent once it's
registered. The commit browser half (branch/base pickers, `⌘←/⌘→` stepping)
and replacing the built-in tab are phase 3.

The principle: **an extension is data, never code.** It composes trusted
catalog components, reads from allowlisted host queries, and calls
allowlisted host commands.

### Decisions so far

| Question | Decision |
| --- | --- |
| Proof target | Local-changes half first. Full `DiffBrowserView` parity and `replaces` come later |
| Author | End user, through the pane's agent |
| Protocol | **A2UI v1.0** as documented today (Candidate), frozen. We don't track upstream changes |
| Logic | A2UI function calls from a closed catalog. No expression language |
| Paths | JSON Pointer (RFC 6901), relative inside templates, `{call: "@index"}` |
| Wire format | Migrate the live channel to v1.0 in the same step |
| Catalog | One superset catalog, `roer:catalog/1`: A2UI basic plus host components and functions. It's the surface default |
| Host commands | Catalog functions with `allowedCallers`. Writes need `requiresUserActivation` |
| Scope | User (`~/.roer/extensions`) and session only. Project scope is deferred |
| Tab lifecycle | The manifest says `pinned`. Unpinned tabs are opened from a menu and can be closed. No `when` |
| Keybindings | Named chords only, mapped to Roer's platform chords |
| Heavy components | Self-fetching (`DiffView` loads its own diff) |
| Agent writes into a tab | Not in v1 |
| Agent feedback loop | Validation issues on register, plus user comments through an AG-UI-style shared scratch |
| Scratch lifetime | Persists with the tab, so comments can be left on a finished tab |
| Scratch access | Any pane's agent can read and patch it |
| Show/hide | `visible` only, a Roer prop. v1.0's `accessibility.hidden` is for screen readers and means something else |
| Source status | `/$sources/<id>/loading` and `/$sources/<id>/error` |
| Chords, v1 | `nav.prev/next/up/down` and `open`. No `refresh` |
| Commenting | A "Comment" mode on the tab. Actions don't fire while it's on |
| Nudging an agent | The user picks a pane with "Send to agent…" and Roer types a one-line prompt there |
| Comment snapshot | The templated item under the click, plus that surface's `/$sources` status |
| Chord scope | Registered only while the extension's tab is on top |
| Roer-only functions | `eq`, `length`, `isSet` stay in `roer:catalog/1`. Revisit when v1.0 is final |

---

## What exists today, and what's missing

| Piece | Where |
| --- | --- |
| Wire format (A2UI v1.0, phase 0) | `src/generative-ui/schema.ts` |
| Reducer | `src/generative-ui/apply.ts` |
| Trusted, closed catalog renderer | `src/generative-ui/GenerativeSurface.tsx` |
| Terminal → app channel, app → terminal actions | `src-tauri/src/plugin_ui.rs`, `roer plugin-ui[-actions]` |
| Agent entry points | `roer mcp`: `show_ui`, `read_ui_actions`, `save_ui`, `load_ui` |
| Persistence | `.roer/plugin-ui/bundles/<name>/` |

That handles *agent-driven, ephemeral* UI. A generated tab needs:

1. **The host as a data source**, so the tab stays fresh without an agent (§3).
2. **Bindings, functions, and templates**: "one row per item in
   `/changes/files`", and "this row is selected" (§4).
3. **Rich host components** that wrap existing React code (`DiffPane`) and
   fetch their own data (§4).
4. **Contribution points**, so an extension can become a stage tab (§2).
5. **A feedback loop**, so the user can steer the agent while it iterates on
   the tab (§7).

---

## 0. Prerequisite: move to A2UI v1.0

This happens before any extension work. There's only one consumer today, so
it's cheap now and expensive later.

**We target v1.0 as it's documented today and freeze it.** v1.0 is still a
Candidate, but Roer is both the agent side and the renderer, so we don't
need to interoperate with anyone else's build. Every envelope carries
`"version": "v1.0"`, meaning *this* snapshot. We don't follow later upstream
changes, and there's no conformance test against upstream schemas. Adopting
a later revision would be a deliberate spec change of its own.

The snapshot is the upstream repository's `specification/v1_0/json/` schemas
and basic catalog as they stand today. They're more precise than the
evolution guide, and the guide's gaps are filled from them:

| Detail | v1.0 schema |
| --- | --- |
| Function call | `{ "call": name, "args"?: {…}, "catalogId"? }` |
| Component | `{ "id", "component", "catalogId"?, "accessibility"?, "metadata"?, …props }` |
| `updateDataModel` | `{ "surfaceId", "path"?, "value" }`: `value` is required, `null` deletes, and no `path` (or `"/"`) means the whole model |
| `deleteSurface` | `{ "surfaceId" }` |
| `@index` | `{ "call": "@index", "args"?: { "offset"? } }` |
| Accessibility | `{ "label"?, "description"?, "live"?, "hidden"? }`, where `hidden` is for assistive technologies only |
| Button action | `{ "event": { "name", "userMessage"?, "context"? } }` or `{ "functionCall": {…} }` |
| Renderer → agent click | `{ "version", "action": { "name", "surfaceId", "sourceComponentId", "timestamp", "context", "userMessage"? } }` |
| `callRendererFunction` | `{ "functionCallId", "callFunction": FunctionCall }`, where `callFunction` must name its `catalogId` |
| Function responses | `{ "functionCallId", "value" }` or `{ "functionCallId", "error": { "code", "message" } }` |

Two places where Roer departs from the snapshot on purpose:

- **Re-creating a surface replaces it.** v1.0 calls that an error, but Roer
  has no error channel back to the agent yet, so a message that's silently
  refused would look like a UI that never updates. `roer plugin-ui load`
  sends `deleteSurface` first anyway.
- **`sendDataModel` rides on the transport.** v1.0 puts the data model in
  A2A message metadata. Roer has no A2A, so the action record carries it
  next to the message: `{ pane, message, dataModel? }`.

- **Paths → JSON Pointer.** `readPointer`/`writePointer` in `schema.ts` take
  `/files/0/include`, and refuse `__proto__`, `constructor`, and `prototype`. Inside a template, a path without a leading `/` is
  relative to the current item. `~1` and `~0` escapes follow RFC 6901.
- **Messages.** Agent → renderer: `createSurface`, `updateComponents`,
  `updateDataModel`, and `deleteSurface`, plus `callRendererFunction` and
  `agentFunctionResponse` once there are renderer functions (phase 1).
  Renderer → agent: `action` now, and `callAgentFunction`,
  `rendererFunctionResponse`, and `error` later. `isA2uiMessage` accepts
  only the v1.0 envelope.
  - `createSurface` can carry `components` and `dataModel` inline, so one
    message is a complete UI. That's exactly what a manifest surface is (§1).
  - `updateDataModel` requires `value`, and `null` deletes the key.
  - A surface has a reserved `Surface` root whose child is the component
    with id `"root"`. The old `root` field goes away.
- **Components → v1.0 shape.** Every string, number, or boolean prop is a
  `Dynamic` value (§4). Templated children become
  `children: { path, componentId }`. Components may carry `accessibility`
  (`label`, `description`, `live`, `hidden`), which we pass straight to
  ARIA. The basic catalog's own shapes change too: a `Button`'s label is a
  child component, a `Card` has one `child`, `Checkbox` is `CheckBox` with a
  bound `value`, and `ButtonRow` is gone (use `Row`).
- **Catalog.** `roer:catalog/1` is a v1.0 catalog definition
  (`protocolVersion: "1.0"`). It re-exports A2UI's basic catalog and adds
  our host components and functions (§4, §5). It's every surface's default
  `catalogId`, so no component has to name a catalog. Mixing catalogs per
  component stays available for later component packs.
- **Saved bundles.** A bundle is now one `surface.json` holding its
  `createSurface`, with components and data model inline, plus `prompt.md`.
  A pre-v1.0 bundle (`surface-update.json` + `data-model.json`) is upgraded
  by the app the first time it's opened (`generative-ui/legacy.ts`) and
  written back, which removes the old files. Upgrading needs the catalog, so
  `roer plugin-ui load` refuses an old bundle and says to open it in the app
  once. There's no long-lived dual format.

---

## 1. The extension manifest

An extension is a directory holding an `extension.json`:

```
~/.roer/extensions/<id>/extension.json   # user scope, every project
(in memory)                              # session scope: registered live, gone on restart
```

Project scope (`<project>/.roer/extensions/`) is deferred. It raises the
question of trusting a freshly cloned repo, and nobody has asked for it yet.

```ts
interface ExtensionManifest {
  apiVersion: 1;
  id: string;                       // [a-z0-9-]+, unique; session scope shadows user scope
  name: string;                     // shown in the tab menu and the extension list
  description?: string;
  catalogId?: "roer:catalog/1";    // the default; v1.0 allows a per-component override
  /** How it was made, so an agent can regenerate or tweak it. */
  generatedFrom?: { prompt: string; model?: string; at?: string };

  /** What the extension may touch. Checked when it loads, and shown to the user. */
  capabilities: Capability[];
  contributes: Contribution[];

  /** Each surface is the body of a v1.0 `createSurface`: components (one with
   *  id "root") and the initial data model inline. */
  surfaces: Record<SurfaceId, { components: Component[]; dataModel?: DataModel }>;
  sources?: Record<SourceId, Source>;
  actions?: Record<ActionId, Action>;
}

type Capability =
  | "git:read"                      // status, diff, log, branches
  | "git:write"                     // stage / unstage (phase 3, behind a prompt)
  | "files:read"                    // files under the session root
  | "stage:open";                   // open file tabs, switch tabs
```

`github:read` and an agent-reporting capability are out of v1. They come
with the Pull Request port and agent writes respectively.

---

## 2. Contribution points

```ts
type Contribution =
  | {
      kind: "stageTab";
      id: string;
      title: string | DynamicString;  // "Changes (3)"
      surface: SurfaceId;
      /** true: always in the strip, like Terminal and Changes.
       *  false (default): listed in the strip's "+" menu, opened on demand, closeable. */
      pinned?: boolean;
      order?: number;                 // after the built-ins by default
      badge?: DynamicString;
      keybindings?: Keybinding[];     // active only while this tab is on top
    }
  | {
      kind: "sidePanel";              // today's Generative UI panel, now multi-surface
      id: string;
      title: string;
      surface: SurfaceId;
    };
```

There's no `when`: a tab is either pinned or opened by hand. `replaces` comes
in phase 3, together with commit-browser parity.

### Tabs

```ts
// src/lib/tabs.ts
export type StageTab =
  | { kind: "terminal" }
  | { kind: "changes" }
  | { kind: "pullRequest" }
  | { kind: "file"; root: string; path: string; line?: number }
  | { kind: "extension"; extension: string; contribution: string };
// tabId → `ext:<extension>/<contribution>`
```

Open extension tabs get their own list next to `files`. They don't count
against `MAX_FILE_TABS`, and they're never LRU-evicted. They join `used` so
the MRU still describes the whole stage. Closing one drops its runtime (§6).
Pinned ones are always present and have no close button.

### Keybindings: named chords

Extensions can't spell out keys. They bind actions to a fixed vocabulary
that Roer maps to its own platform chords in `lib/keys.ts`. This avoids a
new key parser, the question of what "mod" means off macOS (Roer already has
two: `appChord` = ⌘ / Ctrl+Shift and `navChord` = ⌘ / Alt), and collisions
with app shortcuts.

```ts
interface Keybinding {
  chord: NamedChord;
  action: ActionId;
}

type NamedChord =
  | "nav.prev" | "nav.next"   // navChord + ←/→ (today's isPrevCommit/isNextCommit)
  | "nav.up"   | "nav.down"   // navChord + ↑/↓ (new)
  | "open";                   // Enter, when focus isn't in a text field
```

**Scope.** `useHotkey` listens on `window` in the capture phase, so a
registered chord takes the key before xterm sees it. Extension chords are
therefore registered only while their tab is on top, the same way
`DiffBrowserView` gates on `active`. At that point the terminal is hidden
behind the tab, so the shell never loses `⌘↑/↓` or Alt+arrows. The cost is
that `⌘↑/↓` no longer scrolls the tab to its top or bottom. `open` is
ignored while focus is in a text field.

There's no `refresh` chord: `⌘R` is the webview's reload, and sources
already re-run on `files.changed` and `activate`. A manifest that wants a
manual refresh uses a `Button` with a `refresh` step.

Adding a chord means adding it to `keys.ts`, where it gets a label in
`shortcutLabel` and a test, and then to `describe_host`.

---

## 3. Sources: the host as the "agent"

A **source** is a named, read-only host query. The host runs it, writes the
result into the surface's data model at `into`, and runs it again when its
triggers fire.

```ts
interface Source {
  query: QueryName;
  args?: Record<string, DynamicValue>;  // a change to a bound arg re-runs the query
  into: JsonPointer;                    // "/changes"
  refreshOn?: Trigger[];
  /** Skip while any of these paths is unset. */
  requires?: JsonPointer[];
}

type Trigger =
  | "mount"            // first time the surface is shown
  | "activate"         // each time its tab comes on top
  | "files.changed"    // the worktree watch (onFilesChanged)
  | "session.cwd"      // a `cd` inside the pane
  | { every: number }; // seconds, clamped to at least 5
```

Loading and error state live under one reserved root, keyed by source id:
`/$sources/<id>/loading` (boolean) and `/$sources/<id>/error`
(string | null). They're plain JSON Pointers with no escaping quirks, and
they can't collide with a query result. The validator rejects an `into` or a
`set` path under `/$sources`.

**The runtime resolves the repository, not the manifest.** `git_diff`,
`git_commit_*` and friends take a `root`, but a session knows only
`cwd`/`pane`. The `ExtensionRuntime` resolves `root` once per session
(`resolveDir` → `git_root`, the same work `DiffBrowserView` does) and passes
it to every `git.*` query. Sources never need to chain, and a `cd` into a
different repo re-resolves `root` and re-runs everything.

### Query registry, v1

| Query | Args | Result | Capability | Backed by |
| --- | --- | --- | --- | --- |
| `session.info` | — | `{ cwd, root, branch }` | — | `resolveDir`, `git_root`, `git_current_branch` |
| `git.changes` | — | `Changes` + `count` | `git:read` | `git_changes` |
| `git.branches` | — | `string[]` | `git:read` | `git_branches` (phase 3) |
| `git.branchCommits` | `branch`, `base` | `Commit[]` | `git:read` | `git_branch_commits` (phase 3) |
| `git.commitFiles` | `commit` | `FileChange[]` | `git:read` | `git_commit_files` (phase 3) |
| `files.read` | `path` | `{ text, lang }` | `files:read` | `files.rs` |

There's no `git.diff` query: diffs belong to `DiffView` (§4). Derived fields
are added host-side where every consumer needs them: `FileChange` gains
`status` (`statusLetter`), `kind` (`changeKind`), `untracked`, `staged`, and
`name` (`baseName`), and `Changes` gains `count`.

---

## 4. Catalog additions

### Dynamic values

Following A2UI, any string, number, or boolean prop is a `Dynamic`
value:

```ts
type DynamicValue =
  | string | number | boolean                         // literal
  | { path: JsonPointer }                             // "/selected/path", or "path" inside a template
  | { call: FunctionName; args: Record<string, DynamicValue> };
```

### Functions

A closed, pure, side-effect-free set, declared in `roer:catalog/1`. There's
no general expression language: when a manifest needs something new, we add
a function or a derived query field.

| Function | Args | Returns | Source |
| --- | --- | --- | --- |
| `formatString` | `value` with `${/path}` interpolation | string | A2UI basic |
| `pluralize` | `count`, `one`, `other` | string | A2UI basic |
| `and` / `or` | `values: DynamicBoolean[]` | boolean | A2UI basic |
| `not` | `value` | boolean | A2UI basic |
| `eq` | `a`, `b` (scalars) | boolean | Roer |
| `length` | `value` (array or string) | number | Roer |
| `isSet` | `value` | boolean: not undefined, null, or "" | Roer |

The template index is v1.0's system function `{ "call": "@index" }` (with an
optional `offset`), and it's valid only inside a template. `eq`, `length`,
and `isSet` exist only in `roer:catalog/1`. We'll revisit that when v1.0 is
final, in case it adds comparison functions of its own.

Every component gets **`visible?: DynamicBoolean`**, which is a Roer prop,
not part of A2UI. It isn't `hidden`: v1.0's `accessibility.hidden` hides a
component from screen readers only. A second top-level `hidden` meaning
"not rendered" would sit right next to it and mean something else. A
templated container also gets `emptyText?: string`.

### Structure rules and instructions

The catalog uses two v1.0 features to steer generation before validation
has to catch anything:

- **`allowedParents` / `allowedChildren`.** `SplitPane` is allowed only
  under `Surface`. `FileRow` is allowed only as a `List` template. `DiffView`
  can't go inside a `List`, which also stops a manifest from rendering one
  diff per row. Violations are reported as v1.0's `UNALLOWED_PARENT` /
  `UNALLOWED_CHILD`.
- **`instructions`.** The catalog's free-text guidance, which is v1.0's
  replacement for `rules.txt`, is where "put diffs in `DiffView`, not
  `CodeBlock`", "bind loading state from `/$sources`", and similar advice
  live. `describe_host` returns it with the schema.

### Templated children

```json
{ "id": "files", "component": "List", "emptyText": "No local changes",
  "children": { "path": "/changes/files", "componentId": "fileRow" } }
```

Inside `fileRow` and its descendants, relative paths (`"path"`, `"status"`)
resolve against the current element.

### Host components

These are trusted and rendered by existing React code. As A2UI's custom
catalogs allow, a host component may **fetch its own data** under the
extension's capabilities. The manifest provides only the props.

| Component | Props | Renders |
| --- | --- | --- |
| `DiffView` | `path`, `untracked?` — or `commit`, `path` | `DiffPane`. Calls `git_diff`/`git_commit_diff` itself under `git:read`. Refetches when `files.changed` names its path or reports `broad` |
| `FileRow` | `path`, `status?`, `added?`, `deleted?`, `selected?: DynamicBoolean`, `action` | The row style Changes uses today |
| `SplitPane` | `start`, `end`, `initial?`, `persistKey?` | A resizable two-pane layout |
| `Select` | `options`, `valuePath` | Branch pickers (phase 3) |
| `Badge` | `text`, `tone?: "neutral" \| "added" \| "deleted" \| "warning"` | A status letter or count |
| `Spinner` / `ErrorText` | `text?` | Loading and error, bound to `/$sources/<id>/…` |
| `CodeBlock` | `text`, `lang?` | Read-only code built on `CodeLine` |

A self-fetching component keeps large strings out of the data model. It
still can't do anything its extension's capabilities don't allow: the
runtime hands it a capability-checked client, never a raw `invoke`.

The existing rules still hold: unknown types render as a visible
placeholder, and cycles are cut.

---

## 5. Actions

`action` names an entry in `actions`. An action is a short list of steps,
with no loops, conditionals, or expressions:

```ts
type Action = { steps: Step[] };

type Step =
  | { op: "set"; path: JsonPointer; value: DynamicValue }        // write the data model
  | { op: "refresh"; source: SourceId }                          // re-run a query now
  | { op: "select"; list: JsonPointer; path: JsonPointer; delta: 1 | -1 } // step a selection
  | { op: "call"; call: HostFunction; args?: Record<string, DynamicValue> };
```

Host commands are **v1.0 catalog functions**, so they're described, checked,
and called the same way as `eq` and `formatString`. Each one declares who may
call it (`allowedCallers`) and whether it needs a real click or keypress
(`requiresUserActivation`):

| Function | Args | Capability | `allowedCallers` | `requiresUserActivation` |
| --- | --- | --- | --- | --- |
| `stage.openFile` | `path`, `line?` | `stage:open` | `rendererOnly` | true |
| `stage.activate` | `tab` | `stage:open` | `rendererOnly` | true |
| `clipboard.copy` | `text` | — | `rendererOnly` | true |
| `git.stage` / `git.unstage` | `path` | `git:write` (phase 3) | `rendererOnly` | true |

`requiresUserActivation` is the useful guarantee here. A write can only
come from an action that a click or a named chord triggered. It can never
come from a source refresh, a hot reload, or anything the agent sends. That
holds even for an extension that has `git:write`.

A relative path in an action resolves against the item of the component
that fired it, which is how a click on a templated row knows which file it
was. `{ "path": "" }` inside a template means the whole item.

`select` finds the current value of `path` in `list`, compares elements by
their `path` field (or by value for scalars), and moves `delta` steps,
clamped at the ends. It sets the first element when nothing is selected.

There's no `op: "agent"` in v1: a registered tab doesn't talk to the pane's
agent. When agent writes arrive (phase 4), that becomes v1.0's
`callAgentFunction` rather than a Roer-specific step. A step whose capability isn't declared is rejected before anything
runs, and the tab shows an error card.

---

## 6. Host-side registry

This lives in `src/extensions/`. Built-in tabs move onto it in phase 4.

```ts
export interface LoadedExtension {
  manifest: ExtensionManifest;
  scope: "user" | "session";
  status: "active" | "disabled" | { error: string };
}

export interface ExtensionRegistry {
  list(): readonly LoadedExtension[];
  get(id: string): LoadedExtension | undefined;
  /** Validate, check capabilities (asking if needed), activate. Replaces any registration with the same id. */
  register(manifest: unknown, scope: LoadedExtension["scope"]): Promise<Result<LoadedExtension, Issue[]>>;
  unregister(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  subscribe(listener: () => void): () => void;
}
```

**Runtime per (extension, pane).** Each mounted surface gets an
`ExtensionRuntime` that owns its `RenderState` (the existing reducer),
resolves `root` for *that* session, runs sources, hands capability-checked
clients to host components, and routes actions. It is keyed by pane for the
same reason `App.tsx` resets the generative panel when the pane changes:
state from one session must never act on another.

**Validation.** `validateManifest(unknown): Result<ExtensionManifest, Issue[]>`
reports path-precise issues, for example:

```
/surfaces/changes/components/4/children: unknown componentId "fileRow"
/sources/changes/query: "git.diff" is not a query; DiffView fetches diffs itself
/contributes/0/keybindings/1/chord: "mod+j" is not a named chord (nav.prev, nav.next, …)
/surfaces/changes/components/9: UNALLOWED_PARENT — DiffView can't be a child of List
/surfaces/changes/components/2/hidden: not a prop; use "visible" (accessibility.hidden is for screen readers)
```

The validator also checks that every `{call}` names a catalog function with
the right args, that `@index` appears only inside templates, that each
surface has exactly one `"root"`, and that every capability a query, host
function, or self-fetching component needs is declared.

**Hot reload.** A `notify` watcher on `~/.roer/extensions/` (the same shape
as `watch_records`) re-registers an extension when its manifest changes. The
data model survives if the surface id stays the same.

---

## 7. Registering and iterating: CLI, MCP, and the scratch

### CLI

```
roer ext register [--session] <dir | ->   validate and install (stdin = manifest JSON)
roer ext validate <dir | ->               print issues, exit 2 on error
roer ext list | remove <id> | enable <id> | disable <id>
```

### MCP (`roer mcp`)

| Tool | Purpose |
| --- | --- |
| `describe_host` | `roer:catalog/1` as a v1.0 catalog definition (components, functions, `instructions`), plus queries, named chords, and capabilities. Generation starts here. |
| `register_extension` | `{ manifest, scope }` → `{ ok, issues[] }`. `scope: "session"` for drafts. |
| `get_extension` | Read back a manifest so it can be edited incrementally. |
| `remove_extension` | |
| `preview_extension` | Render it into the side panel with live sources, before it becomes a tab. |
| `list_extensions` | Ids, names, scope, status, and unresolved comment count. |
| `read_extension_scratch` / `patch_extension_scratch` | The shared scratch, below. |

Under the hood, the tools that act on a live surface (`preview_extension`,
the scratch tools) are thin wrappers over **agent-callable renderer
functions**, i.e. v1.0 `callRendererFunction` with
`allowedCallers: "agentOnly"`. Refused calls come back as v1.0's
`INVALID_FUNCTION_CALL`. That keeps the permission model in one place, the
catalog, whether the call comes from a click or from an agent.

`show_ui`, `save_ui`, and `load_ui` stay, on the v1.0 wire format. A saved
bundle is an extension with one `sidePanel` contribution and no sources, and
`roer ext register` can import one.

### Feedback: the shared scratch

Each extension has a **scratch**: a JSON document shared
between the preview UI and the authoring agent. It follows AG-UI's shared
state model, synced as `STATE_SNAPSHOT` plus `STATE_DELTA` (RFC 6902 JSON
Patch, which uses the same JSON Pointers as the rest of the manifest). The
scratch is **not** the surface's data model. The agent still can't change
what a registered tab renders, which keeps "no agent writes in v1" intact.

```ts
interface Scratch {
  comments: {
    id: string;
    componentId: ComponentId;       // what the user clicked in the preview
    itemPath?: JsonPointer;         // e.g. "/changes/files/3" for a templated row
    /** What the user was looking at: the item at `itemPath` when they clicked,
     *  plus the surface's `/$sources` status. Never the whole data model. */
    snapshot?: { item?: unknown; sources: Record<SourceId, { loading: boolean; error: string | null }> };
    text: string;
    at: string;
    resolved?: boolean;             // the agent flips this after a fix
  }[];
  /** Free-form notes the agent leaves for itself or the user ("tried X, reverted"). */
  notes?: string;
}
```

The loop:

1. The agent calls `register_extension` with `scope: "session"`, gets
   issues, and fixes them until `ok`.
2. The user turns on **Comment mode** from the tab's (or preview's) menu.
   Hovering outlines components, a click opens a note box, and actions and
   chords don't fire while the mode is on. The note is appended to the
   scratch with its snapshot.
3. The user clicks **Send to agent…** and picks a pane. Roer types one line
   into that pane's prompt, such as `3 comments on local-changes —
   read_extension_scratch`, and doesn't submit it. Until then, comments just
   queue, and no agent is interrupted without the user choosing to.
4. The agent reads it with `read_extension_scratch`, edits the manifest,
   re-registers, and patches `resolved: true`.
5. Once the user is happy, the agent registers with user scope, or the user
   runs `roer ext register`.

**The scratch persists with the tab.** A session-scoped draft keeps it in
memory. Once the extension is saved it moves to
`~/.roer/extensions/<id>/scratch.json`, and the tab keeps its comment
affordance, so the user can leave a note on a finished tab weeks later.

**Any pane's agent can read and patch it.** The scratch tools are available
in every `roer mcp` session, not just the one that wrote the extension,
which also has probably left by the time a later comment arrives.
`list_extensions` reports the number of unresolved comments for each
extension, so an agent can find work without polling each scratch. Two
agents patching at once is handled with JSON Patch `test` ops: a patch whose
`test` fails is rejected, and the agent re-reads the scratch and retries.
The trade-off is that every agent on the machine can see every extension's
comments. That's acceptable for user scope, and project scope will have to
revisit it.

**Trust.** Read-only capabilities activate immediately. Registering an
extension with `git:write` for the first time, or changing its capability
set, shows a prompt listing the capabilities and `generatedFrom.prompt`.

---

## 8. Worked example: local changes as an extension

```json
{
  "apiVersion": 1,
  "id": "local-changes",
  "name": "Local changes",
  "catalogId": "roer:catalog/1",
  "generatedFrom": { "prompt": "A tab with changed files on the left and the selected file's diff on the right." },
  "capabilities": ["git:read", "stage:open"],

  "contributes": [{
    "kind": "stageTab",
    "id": "main",
    "title": { "call": "formatString", "args": { "value": "Local (${/changes/count})" } },
    "surface": "changes",
    "keybindings": [
      { "chord": "nav.down", "action": "next" },
      { "chord": "nav.up", "action": "prev" },
      { "chord": "open", "action": "open" }
    ]
  }],

  "sources": {
    "changes": { "query": "git.changes", "into": "/changes",
                 "refreshOn": ["mount", "activate", "files.changed", "session.cwd"] }
  },

  "actions": {
    "pick": { "steps": [{ "op": "set", "path": "/selected", "value": { "path": "" } }] },
    "next": { "steps": [{ "op": "select", "list": "/changes/files", "path": "/selected", "delta": 1 }] },
    "prev": { "steps": [{ "op": "select", "list": "/changes/files", "path": "/selected", "delta": -1 }] },
    "open": { "steps": [{ "op": "call", "call": "stage.openFile",
                          "args": { "path": { "path": "/selected/path" } } }] }
  },

  "surfaces": {
    "changes": {
      "components": [
        { "id": "root", "component": "SplitPane", "start": "left", "end": "right", "initial": 320, "persistKey": "local-changes" },

        { "id": "left", "component": "Column", "children": ["branch", "loading", "error", "files"] },
        { "id": "branch", "component": "Text", "muted": true, "text": { "path": "/changes/branch" } },
        { "id": "loading", "component": "Spinner", "visible": { "path": "/$sources/changes/loading" } },
        { "id": "error", "component": "ErrorText", "text": { "path": "/$sources/changes/error" },
          "visible": { "call": "isSet", "args": { "value": { "path": "/$sources/changes/error" } } } },
        { "id": "files", "component": "List", "emptyText": "No local changes",
          "children": { "path": "/changes/files", "componentId": "fileRow" } },
        { "id": "fileRow", "component": "FileRow", "action": "pick",
          "path": { "path": "path" }, "status": { "path": "status" },
          "added": { "path": "added" }, "deleted": { "path": "deleted" },
          "selected": { "call": "eq", "args": { "a": { "path": "path" }, "b": { "path": "/selected/path" } } } },

        { "id": "right", "component": "Column", "children": ["pickHint", "diffView"] },
        { "id": "pickHint", "component": "Text", "muted": true, "text": "Select a file",
          "visible": { "call": "not", "args": { "value": { "call": "isSet", "args": { "value": { "path": "/selected/path" } } } } } },
        { "id": "diffView", "component": "DiffView",
          "path": { "path": "/selected/path" }, "untracked": { "path": "/selected/untracked" },
          "visible": { "call": "isSet", "args": { "value": { "path": "/selected/path" } } } }
      ]
    }
  }
}
```

The example needs no magic suffixes and no manifest-level `root` field. The
one `not(isSet(…))` is the price of having only `visible`. If generated
manifests keep reaching for it, add `isUnset` to the catalog.

---

## 9. Rollout

0. **v1.0 migration** (done on `a2ui-v1`). JSON Pointer paths, v1.0
   envelopes and the four surface messages, inline `createSurface`, the
   basic catalog's v1.0 component shapes, templates with `@index`,
   accessibility, and a one-shot upgrade of saved bundles. Moved to
   phase 1: the function-call RPCs and the `roer:catalog/1` catalog
   definition file (with `allowedParents` and `instructions`). Both ship
   with `describe_host` and the first renderer functions, which is the
   first point anything would use them. `show_ui`
   keeps working throughout.
1. **Read-only tab.** The `roer:catalog/1` definition and function-call RPCs
   carried over from phase 0, the basic catalog's functions, `visible`, sources (`git.changes`, `session.info`) with
   runtime-resolved `root` and `/$sources` status,
   `stageTab` (pinned and openable), `DiffView`/`FileRow`/`SplitPane`,
   `validateManifest`, `roer ext register --session`, and MCP
   `describe_host`/`register_extension`/`preview_extension`. Done when the
   manifest above renders next to the built-in Changes tab and stays live.
2. **Interaction and iteration.** Actions (`set`, `select`, `refresh`,
   `call` with `stage.*` under `requiresUserActivation`), named chords, user scope on disk, hot reload, and the
   persistent scratch with comments on previews and finished tabs.
3. **Parity and replacing.** The commit-browser half (`Select`,
   `git.branches`/`branchCommits`/`commitFiles`, `DiffView{commit}`, hiding
   the local slot off `HEAD` via `eq`), `replaces: "changes"`, `git:write`
   plus the trust prompt.
4. **Later.** Project scope, the Pull Request port (`github:read`), agent
   writes into tabs (`agentWritable` paths, `callAgentFunction`), `when` conditions, and the
   built-in tabs moved behind the registry.

## Open questions

- **Typed, not submitted?** "Send to agent…" types into the pane's prompt.
  Should it stop there, or also press Enter? Stopping there is safer if the
  agent is mid-task. Pressing Enter saves a keystroke.
- **Comment mode on pinned tabs.** Is the tab menu the right entry point
  for a pinned tab, which has no close button and so perhaps no menu yet?
