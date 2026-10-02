# Writing a Roer extension

A Roer extension adds a tab to Roer's stage, next to Terminal, Changes and
Pull Request. It is a folder with a manifest and a React entry point. Roer
builds it with Bun, loads it into its own window and reloads it every time a
file in the folder changes. Roer's own Changes tab is an extension written
this way.

Read all of this before writing anything. The type declarations at the end
are the whole API: anything they don't declare isn't there.

## The folder

```
<id>/
  extension.json
  app.tsx        the entry point; it may import other files of the folder
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
  work: add a `package.json` and run `bun install` in the folder. An
  extension runs in a browser window, so Node's modules aren't available
  there.
- Whatever the API doesn't offer, `invoke(command, args)` can reach. Roer's
  backend commands are the ones `src-tauri/src/lib.rs` registers. Prefer the
  typed functions.
- Put a `data-roer-id` on the elements that matter. Comments the person
  leaves on the tab are pinned to them.

### Looking like Roer

Use Roer's classes and colours, not your own palette, so the tab matches
the light and dark themes:

- Classes: `empty` (a centred message filling the tab), `muted`, `error`,
  `primary` on a button, `link` on a button that reads as a link.
- Variables: `--roer-bg`, `--roer-fg`, `--roer-panel`, `--roer-border`,
  `--roer-muted`, `--roer-accent`, `--roer-warn`, `--roer-plus`,
  `--roer-minus`, `--roer-row`, `--roer-row-hover`, `--roer-selected`.
- The tab fills the stage. Give its root `height: 100%; overflow: auto`
  when it scrolls.
- Import a `.css` file from `app.tsx` and Roer adds it to the page. Prefix
  every class with the extension's id, because the page is shared.

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
