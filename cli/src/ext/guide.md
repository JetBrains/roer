# Writing a Roer extension

A Roer extension adds a tab to Roer's stage, next to Terminal and Changes.
It is a folder with a manifest and a React entry point. Roer
builds it with Bun, loads it into its own window and reloads it every time a
file in the folder changes. Roer's own Changes tab is an extension written
this way.

Read all of this before writing anything. The type declarations at the end
are the whole API: anything they don't declare isn't there. `roer` is the
frontend's module, `roer/ui` its components, and `roer/server` the module
for the backend.

## The folder

```
<id>/
  extension.json
  app.tsx        the entry point; it may import other files of the folder
  server.ts      optional: a backend that can run programs (below)
  roer.d.ts      the API's types, written by `roer ext new`; the build doesn't read it
```

```json
{
  "apiVersion": 1,
  "id": "todos",
  "name": "TODOs",
  "description": "Every TODO in the repository",
  "roer": ">=0.8",
  "app": "app.tsx",
  "generatedFrom": { "prompt": "a tab that lists the TODOs in this repo" }
}
```

`id` is lowercase letters, digits and dashes. Record the person's request in
`generatedFrom.prompt`, so whoever edits the extension later knows what it
was for.

## app.tsx

```tsx
import { useEffect, useState } from "react";
import { defineExtension, filesGrep, useOpenFile, useSession, type GrepHit } from "roer";

function Todos() {
  const session = useSession();
  const openFile = useOpenFile();
  const [hits, setHits] = useState<GrepHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const root = session?.root;
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    filesGrep(root, "TODO")
      .then((found) => !cancelled && setHits(found))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // `changed` is a new value whenever the worktree changes: read again then.
  }, [root, session?.changed]);

  if (!root) return <div className="empty"><p className="muted">Not in a git repository.</p></div>;
  if (error) return <div className="empty"><p className="error">{error}</p></div>;
  if (!hits) return <div className="empty"><p className="muted">Searching…</p></div>;
  return (
    <ul className="todos" data-roer-id="list">
      {hits.map((hit) => (
        <li key={`${hit.path}:${hit.line}`} onClick={() => openFile(root, hit.path, hit.line)}>
          <span className="muted">{hit.path}:{hit.line}</span> {hit.text.trim()}
        </li>
      ))}
    </ul>
  );
}

export default defineExtension((roer) => {
  roer.stage.registerTab({ id: "main", title: "TODOs", component: Todos });
});
```

The rules:

- `export default defineExtension(...)`, and register tabs from inside it.
  Don't register at the top of the module.
- **A tab component takes no props.** Read the session with `useSession()`.
  It is null while no session is on the stage. `session.root` is null outside
  a repository, and for a moment while it is looked up.
- **Re-read when `session.changed` changes.** That's how a tab stays live as
  the agent edits files. Don't poll.
- **Take keys only while `useActive()` is true.** A `useHotkey` that is
  registered while the tab is hidden takes the key from every other tab.
- `react` and `roer` are Roer's own. Don't install them. Other npm packages
  work: add a `package.json` and run `bun install` in the folder (with no
  `bun` on `PATH`, Roer's own is `~/.roer/bun/1.3.13/bun`). An
  extension runs in a browser window, so Node's modules aren't available
  there.
- Whatever the API doesn't offer, `invoke(command, args)` can reach. Roer's
  backend commands are the ones `src-tauri/src/lib.rs` registers. Prefer the
  typed functions.
- Put a `data-roer-id` on the elements that matter. Comments the person
  leaves on the tab are pinned to them.

## server.ts: running programs

A tab runs in a browser window, so it can't start a program. When it needs
one, such as a CLI whose output it shows, add a `server.ts` and name it in
the manifest with `"server": "server.ts"`. Roer runs it with Bun, with full
access and the login shell's `PATH`, and starts it on the first call.

```ts
// server.ts
import { defineServer } from "roer/server";

export default defineServer((roer) => {
  roer.rpc.handle("todos", async ({ root }: { root: string }) => {
    const out = await roer.exec(["git", "grep", "-n", "TODO"], { cwd: root });
    if (out.code > 1) throw new Error(out.stderr.trim());
    return out.stdout.split("\n").filter(Boolean);
  });
});
```

```tsx
// app.tsx
import { useCall, useRpc } from "roer";

const { data, error, loading, reload } = useRpc<string[]>("todos", { root });
const call = useCall(); // for actions: await call("fix", { line })
```

- `exec` runs a program without a shell. Pass `argv` as a list and never
  build a shell string. A non-zero exit doesn't throw, so check `code`.
- What a handler returns must be JSON. What it throws reaches `useRpc`'s
  `error`, or rejects `call`.
- `console.log` in the server goes to the extension's log (`roer ext logs`).
- Saving any file of the extension stops the server. The next call starts it
  again with the new code.
- Ask before your tab does anything with consequences, as the person would
  expect from you. A button whose action can't be undone needs a confirm
  step.

### Looking like Roer: build from `roer/ui`

Build the tab from `roer/ui`, the Generative UI catalog as React
components. They are the same components a surface an agent draws with
`show_ui` is made of, so the tab looks and behaves like the rest of Roer, in
both themes. Reach for your own markup and CSS only for something the
catalog has no component for.

```tsx
import { Button, Card, Column, Grid, Row, StatTile, StatusCard, Text } from "roer/ui";

<Column>
  <Grid minItemWidth={180}>
    <StatTile label="Open TODOs" value={hits.length} />
  </Grid>
  <StatusCard title="CI" status="running" progress={40} footer={<Button onClick={retry}>Retry</Button>} />
  <Card>
    <Text variant="caption">Last run 5 minutes ago</Text>
  </Card>
</Column>
```

- Layout: `Row`, `Column`, `List`, `Grid` (wraps), `Card`, `Tabs`,
  `Expandable`, `Modal`, `Divider`.
- Display: `Text` (`variant` `h2` for the tab's title, `h3` for a
  section's, `caption` for secondary text), `Badge`, `Table` (columns that
  line up: a log, a list of jobs), `StatTile`, `StatusCard` (its `status`
  is coloured by meaning: `statusTone`), `WorkItem`, `DiffView`, `Icon`,
  `Image`.
- `EmptyState` is what the tab shows in place of its content: `variant`
  `empty`, `loading` or `error`, with a `footer` for a Retry button. Use it
  rather than your own "Loading…" text.
- Input: `Button`, `TextField`, `CheckBox`, `ChoicePicker` (`chips` for a
  filter bar), `Slider`, `DateTimeInput`. They are controlled: pass `value`
  and `onChange`. A `TextField` without a `label` is a bare box;
  `variant="search"` makes it a filter, and `onSubmit` runs on Enter.
- `DiffView` takes `notes` drawn under their lines. A note with an `author`
  is a comment (markdown, `replies`); give notes an `id` and the view
  `noteActions` (`{ label, value, input?, done? }[]`) and each gets those
  buttons, reported to `onNoteAnswer`. Set the note's `state` to the answer
  to keep it. Roer's own Changes tab (`src/extensions/changes/`) is built
  this way: GitHub's review threads, accepted, declined or instructed.
- `Surface` draws catalog JSON, the same `components` and data model that
  `show_ui` and `save_ui` take, and hands its buttons' events to
  `onAction`. Use it to turn a saved plugin UI into a tab.

For anything else:

- Classes: `muted`, `error`.
- Variables: `--roer-bg`, `--roer-fg`, `--roer-panel`, `--roer-border`,
  `--roer-muted`, `--roer-accent`, `--roer-warn`, `--roer-plus`,
  `--roer-minus`, `--roer-row`, `--roer-row-hover`, `--roer-selected`.
- The tab fills the stage. Give its root `height: 100%; overflow: auto`
  when it scrolls.
- Import a `.css` file from `app.tsx` and Roer adds it to the page. Prefix
  every class with the extension's id, because the page is shared.

## Tools: agents handing things to the tab

When an agent should feed the tab, such as a review's comments, findings
to triage, or a plan to approve, register a tool in `app.tsx`. Agents see
it through `roer mcp` as `<id>__<name>`, with a `session` argument added.
It runs in the app's window, so it can update what the tab shows directly.

```tsx
import { defineExtension, resolveDir, gitRoot } from "roer";
import { store } from "./store"; // the extension's own: localStorage plus listeners the tab subscribes to

export default defineExtension((roer) => {
  roer.stage.registerTab({ id: "main", title: "Findings", component: Findings });
  roer.tools.register({
    name: "add_findings",
    description: "Hand findings to the user's Findings tab, where they triage each one. Don't act on them before they answer.",
    inputSchema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
      required: ["findings"],
    },
    async run(args, { cwd, pane }) {
      const root = await gitRoot(await resolveDir(cwd, pane));
      const added = store.add(root, args.findings);
      roer.badge.set("main", String(added));
      return `Added ${added}; the user will answer them in Roer.`;
    },
  });
});
```

- Check every argument. The schema is a hint to the agent, and the tab gets
  whatever it sends.
- `context.pane` and `context.cwd` say which session called. Key what you
  store by its repository, or its branch, so another session's tab doesn't
  show it.
- Whatever `run` returns is what the agent reads, so tell it what happens
  next. A throw becomes its error.
- The person usually answers in the tab, and the tab sends the answer back
  with `session.send(prompt)`. Give the tab a button that asks the agent to
  use the tool, naming it in the prompt.
- An agent started before the extension loaded still sees the tool: `roer
  mcp` tells it the list changed. To try the tool while developing, call it
  from your own session once `extension_dev` reports the tab up.

Roer's Changes tab (`src/extensions/changes/`) works this way:
`changes__add_comments` puts an agent's review on the branch's diff, and the
person accepts, declines or instructs each comment.

## The loop

1. Write the folder somewhere in the current project, or in a scratch
   directory. `roer ext new <id>` writes a starting point.
2. Run `extension_dev` with the folder (or `roer ext dev <dir>`). Roer builds
   it, loads it as a session extension, and reports the build errors and
   activation errors. Fix them and run it again until it reports none.
3. Every save rebuilds and reloads the tab. `extension_logs` (or `roer ext
   logs <id>`) has the build output, activation errors, and what a tab threw
   while rendering.
4. Tell the person where the tab is and ask them to look at it.
5. When they're happy, run `extension_install` (`roer ext install <dir>`).
   It copies the folder into `~/.roer/extensions/`, which keeps it across
   restarts.

A session extension is gone once Roer restarts, or once its folder is
deleted. `roer ext list` shows what is loaded, and `roer ext remove <id>`
takes one away.

## When not to write one

If the person wants to *see* something once, such as a summary, a form or a
dashboard of the work in front of you, use the Generative UI panel
(`show_ui`) instead. An extension is for a tab they will keep coming back to.
