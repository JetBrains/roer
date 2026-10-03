# Roer Extensions — code extensions

Status: **draft / RFC**. What is built so far:

- Rollout step 2, the thin slice (§11): the registry, loading and hot
  reload, the `roer` SDK, `roer ext`, the MCP tools and the skill.
- From step 4, `server.ts` with `rpc` and `exec` (`extension_servers.rs`,
  `extension_server.ts`), and tools: `roer.tools.register` offers agents a
  tool through `roer mcp` as `<id>__<name>`, run in the app's window. A
  server starts on its first `rpc` call rather than at activation, and
  isn't restarted after a crash until the next call.
- `roer/ui`: the Generative UI catalog as React components, for an
  extension's tab to be built from. The agent's guide (`roer ext guide`)
  documents it.
- A Review tab, bundled beside Changes, built on the SDK alone (§4).
- The Extensions dialog, which switches any extension off (§6).

Bun isn't bundled with the app: a build uses `ROER_BUN`, a Bun beside the
app, `~/.bun/bin/bun` or the `bun` on `PATH`, and with none of them Roer
downloads a pinned release into `~/.roer/bun/<version>/` the first time,
checked against its SHA-256, and uses it from then on (`bun_fetch.rs`).

Everything else here, from `replaces` and forking to the side panel,
events, commands and safe mode, is still design.

## Goal

A person asks the agent in their pane for a tab ("one that lists the TODOs
in this repo", "my Changes tab, but grouped by folder"), and the agent
writes it, installs it and iterates on it until it's right. No Roer release
is involved.

To prove that the API is enough to build real features, Roer's own
Terminal, Changes and Pull Request tabs move onto it as **bundled
extensions**. Their source also serves as the starting point for a fork: a
replacement Changes tab begins as a copy of the built-in, not a blank file.

This spec adds **code extensions**. The data-only extensions of
[`pluginsspec.md`](pluginsspec.md) (A2UI surfaces, host queries and actions,
with no code) remain: they become one kind of extension, the kind an agent
reaches for when the catalog can express the feature (§9).

### Decisions

| Question | Decision |
| --- | --- |
| Author | The end user, through their agent. Roer developers move the built-ins onto the same API |
| Built-ins | Terminal, Changes and Pull Request become bundled extensions. Sessions stays in the core for now |
| Trust | Full trust. Extension code runs in Roer's own webview with the host's React |
| Host access | Raw: `invoke`, `listen`, `Channel` and `fetch`, the same as built-in code. No capability gating |
| Backend | Optional `server.ts`, run by the same Bun that builds extensions, downloaded on first use when the machine has none. It may register tools for agents |
| Contribution points | Stage tab, replacing a built-in tab, side panel, sidebar section, badge, status and toast, commands and chords, context actions, session events |
| Scope | User (`~/.roer/extensions/<id>/`) and session (a development folder, gone on restart). No project scope |
| Agent loop | Errors and logs, a screenshot of the rendered tab, and comments the person pins in Comment mode |
| Agents | An agent-neutral MCP resource and tools in `roer mcp`, and a thin skill for Claude Code |
| Forking | Built-ins import only from the `roer` SDK, so `roer ext fork changes` copies a small, buildable folder |
| Breakage | Best effort: error cards with "Send to agent", fallback to the built-in, safe mode, and a re-check after every Roer update |
| Name | "Extensions". `roer ext`, `~/.roer/extensions` |

---

## 1. An extension on disk

```
~/.roer/extensions/<id>/
  extension.json      manifest
  app.tsx             frontend entry (optional)
  server.ts           backend entry (optional)
  …                   any other files either entry imports
  comments.json       Comment mode pins (§8), written by Roer
```

Roer keeps build output and data outside the folder, so that a fork, a
reinstall or `git` inside the folder never trips over them:

```
~/.roer/extension-cache/<id>/   app.js, app.css, the hash they were built from
~/.roer/extension-data/<id>/    roer.storage (§5)
```

### Manifest

```ts
interface ExtensionManifest {
  apiVersion: 1;
  id: string;                    // [a-z0-9-]+, unique. Session scope shadows user scope
  name: string;
  description?: string;
  /** The Roer versions it was written against, as a semver range. */
  roer: string;                  // ">=0.9"
  app?: string;                  // "app.tsx"
  server?: string;               // "server.ts"
  /** How it was made, so an agent can regenerate it or keep editing it. */
  generatedFrom?: { prompt: string; agent?: string; at?: string };
  /** Set by `roer ext fork`: the bundled extension this one started from, and its version. */
  forkedFrom?: { id: string; roer: string };

  // A data extension (pluginsspec.md) has these and no `app`.
  surfaces?: …; sources?: …; actions?: …; contributes?: …;
}
```

Contributions are registered in code, not declared in the manifest. Every
enabled extension is activated at startup, so nothing has to be listed before
it runs. Under full trust, a static declaration would buy nothing but a
second place to keep in sync.

---

## 2. The frontend: `app.tsx`

```tsx
import { defineExtension, useSession, filesGrep } from "roer";
import { useEffect, useState } from "react";

function Todos() {
  const session = useSession();               // null until a session is on the stage
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!session?.root) return;
    filesGrep(session.root, "TODO").then((hits) => setLines(hits.map((h) => `${h.path}:${h.line} ${h.text}`)));
  }, [session?.root, session?.changed]);
  return <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
}

export default defineExtension((roer) => {
  roer.stage.registerTab({ id: "main", title: "TODOs", component: Todos });
});
```

`defineExtension(activate)` runs `activate` once per load. Each `register*`
call returns a disposable, and Roer disposes them all, last first, on unload
and on reload. An `activate` may also return a cleanup function.

### Contribution points

| Call | What it adds |
| --- | --- |
| `roer.stage.registerTab({ id, title, component, order?, needsSession?, keepAcrossSessions?, pinned?, replaces? })` | A stage tab. `order` places it: Sessions is 0, Terminal 10, Changes 20, Pull Request 30, and the default is 100. The first nine tabs get ⌘1–9. `needsSession` (default true) disables it while no session is on the stage. A pinned tab is always in the strip; an unpinned one is listed in the strip's "+" menu and can be closed. `replaces: "changes" \| "pullRequest" \| "terminal"` takes over that tab's place, title and ⌘ number. In the slice, every tab is pinned and `replaces` isn't there yet |
| `roer.sidePanel.register({ id, title, component })` | A panel on the right, where Generative UI shows today, beside the terminal instead of over it |
| `roer.sidebar.registerSection({ id, title, order?, component })` | A section in the sidebar, under the session list |
| `roer.badge.set(tabId, text \| null)` | A count or dot on one of its tabs |
| `roer.status.set(id, text \| null)` | An item in the status bar |
| `roer.toast(text)` | A toast |
| `roer.commands.register({ id, title, run, chord?, scope? })` | A command, listed in the ⌘/ sheet. `chord` is a named chord (below). With `scope: "tab"` it is active only while its tab is on top |
| `roer.contextMenu.register({ target, title, run })` | An item in the right-click menu of a `"file"`, a `"diffLine"` or a `"session"`. `run` gets what was clicked |
| `roer.events.on(name, fn)` | Session events: `session.start`, `session.exit`, `session.cwd`, `files.changed`, `agent.busy`, `agent.idle`, `pr.draft` |

Named chords are the vocabulary from `pluginsspec.md` §2 (`nav.prev`,
`nav.next`, `nav.up`, `nav.down`, `open`), plus `ext.1` to `ext.9`, which are
Roer's ⌘⌥1–9 (Ctrl+Alt elsewhere). An extension can't spell out keys of its
own, so it can never take a chord from the app or from the shell.

**Replacing.** When two extensions replace the same tab, the user scope one
wins over a bundled one, and a session scope one wins over both. The ⌘/
sheet shows which one is in charge. Settings has "Use the built-in" for each
replaced tab, which turns the replacement off without uninstalling it.

### What a component gets

Components take no props. They read the session, and everything else, through
hooks from `roer`:

```ts
useSession(): Session | null;  // the stage's session; it changes when the stage switches session
useActive(): boolean;          // this tab is on top
interface Session {
  pane: string; cwd: string; root?: string; branch?: string;
  agent?: string;                       // "claude", "codex", …
  busy: boolean;                        // the agent is working
  changed: FilesChanged | null;         // the latest worktree watch batch
  send(text: string, opts?: { submit?: boolean }): Promise<void>; // type into the pane
}
useOpenFile(): (path: string, line?: number) => void;
useActivateTab(): (tabId: string) => void;
```

The rule from `App.tsx` still holds: state from one session must never act on
another. When the session changes, Roer remounts a tab's component (`key` is
the pane), unless the component opts in with
`registerTab({ keepAcrossSessions: true })`.

### The `roer` SDK

The `roer` module is the host's own code, handed to the extension at run time,
the same way as `react`. Nothing is copied into the extension's build.

| Export | From |
| --- | --- |
| `invoke`, `listen`, `Channel` | `src/lib/backend.ts`, so an extension works in the desktop app and over `roer-server` alike |
| `gitChanges`, `gitDiff`, `ghPrForBranch`, `fileRead`, … | the typed wrappers in `src/lib/`, under their own names, which already say what they wrap. `filesGrep(cwd, pattern)` is new: `git grep` over tracked and new files, which also starts the worktree watch, so a tab that greps hears `files.changed`. `filesList(cwd)` is new too: every path `git ls-files` names, tracked and new, for a tab that draws the whole tree |
| `DiffPane`, `Spans`, `TerminalView`, `Markdown` | the components the built-ins are made of. `Markdown` is new: the `react-markdown` + GFM setup `PullRequestView` uses today |
| `parseDiff`, `buildTree`/`rows`, `highlight`, `langFor`, `useHotkey`, `shortcutLabel` | helpers |
| `rpc`, `useRpc` | calls into the extension's own `server.ts` (§5) |
| the `src/components/ui` primitives | buttons, inputs, menus, and Roer's theme tokens |

The SDK is not a frozen contract (§10). Its declarations, though, are what
the agent writes against, so they get the doc comments the agent needs.

---

## 3. Loading, building and hot reload

**Building.** Roer builds `app.tsx` with Bun, the machine's own or the one
it downloaded the first time it needed one (see the status above):
`bun build app.tsx --format esm` into the extension's cache folder. A Bun
plugin resolves `react`, `react/jsx-runtime`, `react-dom` and `roer` to
small shims that read the host's own modules from `globalThis.__roerHost`.
There is one React and one SDK, and the agent never runs a build step itself.
CSS that the entry imports comes out as `app.css`, and Roer links it while
the extension is active.

**Loading.** `extension_bundle(id)` returns the built `app.js` and `app.css`
as text. The frontend imports the JS from a blob URL and puts the CSS in a
`<style>`. That works the same in the desktop app and over `roer-server`,
so neither host needs a URL scheme or a route of its own. The build runs
with `NODE_ENV=production`, because the host's React has no development JSX
runtime.

**Hot reload.** Roer watches `~/.roer/extensions/` and every session scope
folder, with the same debounced watcher as `watch.rs`. A change rebuilds the
extension and emits `roer://extensions`. The frontend then imports the new
module and runs its `activate`. Only if that succeeds does it dispose the old
registrations and swap the new ones in. If the build fails or `activate`
throws, the old version stays live and the error goes to the extension's log
(§8). A `server.ts` change restarts the server process.

**Bundled extensions** live in `src/extensions/<id>/`. They have the same
`extension.json` and `app.tsx`, and they import only from `roer`, `react` and
their own folder; a test enforces this. Vite compiles them into the app
through an alias for `roer`, so they don't need Bun to load. Their source is
also copied into the app's resources (`Resources/extensions/<id>/`), which
is what `fork` copies.

---

## 4. Moving the built-ins

| Built-in | As an extension | What stays in the core |
| --- | --- | --- |
| Changes | `DiffBrowserView` as a pinned tab, using `DiffPane` from the SDK and the prev/next-commit chords | — |
| Review (new) | `src/extensions/code-review/`: the pull request's diff (`ghPrDiff`) in `roer/ui`'s `DiffView`, its review threads as answerable notes (accept, decline, instruct), and the decisions sent with `session.send`. Written against the SDK only, as a fork would be | — |
| Pull Request | `PullRequestView` as a pinned tab, with its badge through `roer.badge` and `pr.draft` through `roer.events`. "Send to agent" becomes `session.send` | — |
| Terminal | A pinned tab whose component renders the SDK's `TerminalView` | The PTY and the handoff state machine (`onAttached`, `onPane`, `onExit`). A replacement can wrap the terminal, with a toolbar or a split, but it can't reimplement the PTY |
| Sessions | Not moved in this spec | All of it: `useSessionBrowser` is the app's session router |

What changes in the shell:

- `StageTab` gains `{ kind: "ext"; ext: string; tab: string }`, with
  `tabId` `ext:<ext>/<tab>`.
- `FIXED_TABS`, the hand-written tab buttons, ⌘1–4 and the shortcut list in
  `keys.ts` are all built from the registry: Sessions first, then pinned
  tabs by `order`.
- Each contribution renders inside an error boundary (§10).
- The "mount once, then hide" behaviour (`everChanges`, `everPr`) becomes
  the registry's default for every tab, so an extension tab keeps its state
  while it's hidden.

---

## 5. The backend: `server.ts`

```ts
import { defineServer } from "roer/server";

export default defineServer((roer) => {
  roer.rpc.handle("pods", async ({ namespace }: { namespace: string }) => {
    const out = await roer.exec(["kubectl", "get", "pods", "-n", namespace, "-o", "json"]);
    return JSON.parse(out.stdout).items;
  });

  roer.tools.register({
    name: "failing_pods",
    description: "Pods that are not Running in a namespace",
    inputSchema: { type: "object", properties: { namespace: { type: "string" } }, required: ["namespace"] },
    run: async ({ namespace }) => /* … */ [],
  });
});
```

**The process.** Roer runs one server per extension, not one per session, as
`bun run <host-shim> <id>`. The shim imports `server.ts` and talks JSON-RPC
to the app over stdio. The server is started when the extension activates,
stopped when it's disabled or removed, and restarted with backoff if it
crashes. Its stdout and stderr go to the extension's log. It is
Bun with full access, like any other program the user runs. Its environment
is the one the app resolves for sessions, so a Finder launch doesn't get the
bare system `PATH`.

**API.** The `roer` object a server gets has:

- `rpc.handle(method, fn)`. The frontend calls it with `rpc.call(method, args)`
  or `useRpc(method, args)`.
- `events.on(…)`, with the same session events as the frontend.
- `exec(argv, { cwd? })`. That's a convenience; `Bun.spawn` works too.
- `storage`: a `bun:sqlite` database in `~/.roer/extension-data/<id>/`.
- `tools.register(…)`: tools for agents.
- `sessions.list()` and `sessions.send(pane, text)`.

**Agent tools.** An extension registers tools in `app.tsx`, with
`roer.tools.register({ name, description, inputSchema, run(args, { pane, cwd }) })`.
They run in the app's window, beside the tab they feed. `roer mcp` lists
every loaded extension's tools as `<id>__<name>` and sends
`notifications/tools/list_changed` when they change.

They ride the same files as the Generative UI panel, so agents reach the
app one way:

| File | Written by | Read by |
| --- | --- | --- |
| `~/.roer/extension-tools.json` | the frontend, whenever the registry's tools change | `roer mcp`, on `tools/list`, and polled for `list_changed` |
| `~/.roer/extension-calls/<id>.json`: `{ id, extension, tool, args, pane, cwd }` | `roer mcp`, on `tools/call` | the app's watcher, which hands it to the frontend and removes it |
| `~/.roer/extension-call-receipts/<id>.json`: `{ result }` or `{ error }` | the window that claimed the call (`extension_call_claim`, first one wins) | `roer mcp`, which returns it as the tool's result |

A record nobody takes within 3 s is removed again, and the agent is told
the app isn't running. A taken call that gets no receipt within 120 s is
reported as unanswered. Tools in `server.ts` would be forwarded to the
server the same way; they aren't there yet.

**Bundling Bun.** About 60 MB per platform, as an `externalBin` next to `roer`
and `tmux`, in the macOS `.dmg` and the Windows and Linux packages. The
release workflow fetches a pinned version and checks its checksum.

---

## 6. Scopes and the CLI

| Scope | Where | Lifetime |
| --- | --- | --- |
| Bundled | the app's resources | ships with Roer |
| User | `~/.roer/extensions/<id>/` | until removed |
| Session | any folder, registered with `roer ext dev` | until the folder is removed or Roer restarts |

```
roer ext new <id> [dir]                      scaffold <dir>/<id>, with roer.d.ts and a tsconfig
roer ext guide                               the agent's guide and the API's types
roer ext dev <dir>                           session scope: build, load, watch, stream logs
roer ext install <dir>                       copy into user scope (replaces the same id)
roer ext fork <bundled-id> [<new-id>]        copy a built-in's source, set replaces and forkedFrom
roer ext list                                id, scope, status, unresolved comments
roer ext remove|enable|disable <id>
roer ext logs <id> [--follow]
roer ext check [<id>]                        type-check against this Roer's SDK (§10)
roer ext safe-mode on|off
```

`install` takes a local folder only. Installing from git or npm needs a
pinning and update story, and nobody has asked to share extensions yet.

**Switching one off.** The Extensions dialog (the puzzle icon in the title
bar) lists every extension, bundled ones included, with its scope, folder and
build errors, and a switch for each. A switched-off extension isn't built or
loaded: its tabs leave the strip, its tools leave `roer mcp`, and its server
stops. The ids are kept in `~/.roer/extensions/.disabled.json`, inside the
watched folder, so a switch reaches every window the way an edit does, and
`roer ext list` reports them as `disabled`. `roer ext enable|disable` would
write the same file; the dialog is the only way so far.

---

## 7. How the agent learns the API

**MCP, for any agent.** `roer mcp` gets:

| Resource / tool | Purpose |
| --- | --- |
| resource `roer:extensions/1` | The guide: the loop below, the contribution points, the SDK's `.d.ts`, how a bundled extension is built, and when to choose a data extension instead |
| `describe_extension_api` | The same guide as a tool, for agents that don't read resources |
| `extension_dev` / `extension_install` | `roer ext dev` / `install`. Returns build errors and activation errors |
| `extension_logs` | The log: build, activation, runtime exceptions from the frontend, and the server's output |
| `extension_screenshot` | A PNG of a contribution as it renders now (§8) |
| `extension_comments` / `resolve_extension_comment` | Comment mode pins (§8) |
| `list_extensions` | What's installed, its status and its unresolved comments |

**A skill, for Claude Code.** `roer-extension-authoring` is installed the
same way as `roer-handoff`. It is short: it triggers on "make me a tab /
panel / extension for Roer" and says to read `roer:extensions/1` before
writing anything. The real content lives in one place, the MCP resource, so
every agent gets the same guide.

**The loop the guide teaches.**

1. Is the catalog enough? If so, write a data extension (`pluginsspec.md`).
2. To change a built-in, `roer ext fork` it. Otherwise `roer ext new`.
3. Write it, and `extension_dev` the folder. Fix what comes back.
4. `extension_screenshot` and look at it. Fix that too.
5. Tell the person it's on screen. Read `extension_comments` when they say
   they've left notes.
6. When they're happy, `extension_install`.

---

## 8. Seeing what the agent built

**Logs.** Each extension has a log:

- build output from Bun
- activation errors
- what the error boundary of each contribution catches
- unhandled rejections raised from its module
- its server's stdout and stderr

The log keeps the last 1000 lines in memory and the last 1 MB on disk at
`~/.roer/extension-cache/<id>/log`.

**Screenshots.** `extension_screenshot { id, contribution?, width?, height? }`
renders the contribution into an off-screen host, 1280×800 by default, on the
stage's current session. It then rasterizes the DOM in the frontend, so it
works over `roer-server` too. A tab that is already on screen is captured
where it is. The result is a PNG in the tool response.

**Comment mode.** This is `pluginsspec.md` §7, generalized from A2UI
components to any DOM:

- The tab menu gets "Comment". While it's on, clicks don't reach the
  extension; hovering outlines elements, and a click opens a note box.
- A pin records the nearest `data-roer-id` attribute, which the guide tells
  agents to put on meaningful elements. Without one, it records a short
  selector path, plus the element's text, cut to 200 characters.
- Pins are saved in `comments.json` in the extension's folder, so they
  survive a reload and can be left on a finished tab.
- "Send to agent…" picks a pane and types `3 comments on todos — read
  extension_comments` without submitting it.
- The agent resolves each pin after it fixes it.

---

## 9. Data extensions

A manifest with `surfaces` and no `app` is a data extension, as
`pluginsspec.md` describes it. It loads through the same registry and
appears in the same `roer ext list`. Its `stageTab` and `sidePanel`
contributions become the same tabs and panels as a code extension's. No Bun
build runs.

That RFC's phases still hold. Where it differs from this spec, this spec
wins:

- The RFC's MCP tool names (`register_extension`, `preview_extension`) fold
  into `extension_dev`.
- The RFC's scratch becomes this spec's `comments.json`.
- The RFC's capabilities and trust prompt stay, for data extensions only.
  They're what lets an agent make one without anybody reviewing code.

---

## 10. When an update breaks an extension

There's no compatibility promise. What Roer does instead:

- **`roer` range.** An extension whose range doesn't include the running
  version loads anyway, with a warning in its log and in `roer ext list`.
- **Error cards.** A contribution that throws renders as a card with the
  error and "Send to agent: fix this extension", which types
  `fix extension <id>: <first line of the error> — see extension_logs`.
- **Fallback.** If a replacement of a built-in fails to build or throws on
  first render, the built-in renders in its place, under a banner that names
  the extension.
- **Re-check after an update.** The first launch of a new Roer version runs
  `roer ext check` on every user scope extension. That's a `tsc --noEmit`
  against the new SDK declarations, with TypeScript shipped alongside Bun.
  It lists the ones that no longer type-check in a single notification,
  before anyone opens their tabs.
- **Safe mode.** `roer ext safe-mode on`, a toggle in Settings, or
  `ROER_SAFE_MODE=1` at launch. Every extension that isn't bundled stays
  unloaded, and their servers don't start.

---

## 11. Rollout

1. **This spec.**
2. **Thin slice, end to end.**
   - the registry, with `StageTab` `ext` and the tab strip, ⌘ numbers and
     shortcut sheet built from it
   - Changes moved to `src/extensions/changes/`
   - the `roer` SDK, enough of it for Changes and the TODO example, with
     `files.grep`
   - Bun building `app.tsx` (bundling Bun into the release moves to step 4,
     with the servers)
   - loading from text through a blob URL, under both hosts
   - hot reload
   - `roer ext new|dev|install|list|remove|logs`
   - `roer:extensions/1`, `describe_extension_api`, `extension_dev`,
     `extension_install`, `extension_logs` and `list_extensions`
   - the skill

   It's done when "make me a tab that lists the TODOs in this repo", asked
   of Claude Code in a Roer pane, ends with that tab in the strip, with no
   hand edits.
3. **Pull Request and Terminal moved, and forking.**
   - `replaces`, `roer ext fork`
   - error cards, the fallback, safe mode and `roer ext check`
4. **Servers.**
   - `server.ts` on Bun, `rpc`, `storage`, `exec`
   - tools in `server.ts`, forwarded over the same files as `app.tsx` tools
5. **Seeing.** Screenshots and Comment mode.
6. **Remaining contribution points, and data extensions.**
   - side panel, sidebar sections, status bar, context menus
   - data extensions loading through the registry (`pluginsspec.md`
     phases 1–3)

## Open questions

- **Servers under `roer-server`.** Servers run on the machine `roer-server`
  runs on. That's right for a remote dev box, but a browser tab on a laptop
  can't reach a server on the laptop. Is that acceptable?
- **Moving Sessions.** It needs `useSessionBrowser` split into a core session
  router and a view. That's worth its own spec once the three tabs have moved.
- **Command palette.** Commands are listed in the ⌘/ sheet for now. A real
  palette is its own feature.
