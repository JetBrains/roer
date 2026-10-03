Roer's Generative UI: a panel beside a Roer session's terminal that draws UI
from a small, fixed catalog of trusted components, never from code you write.
Draft a tree of those components plus the data it reads, and pass the messages
to `show_ui`; Roer shows the panel itself when the first message arrives.

Roer speaks **A2UI v1.0**: every message is an envelope with
`"version": "v1.0"` and exactly one message body. Every body names the
`surfaceId` it belongs to — pick one short id per plugin (e.g.
`"github-issues"`) and reuse it across all of that plugin's messages.

**`createSurface`** — starts a surface. It can carry the whole UI inline:
`components` (a flat list, addressed by `id`) and the initial `dataModel`.
The tree starts at the component whose id is `"root"`. Nothing else is
needed to show it.

```json
{
  "version": "v1.0",
  "createSurface": {
    "surfaceId": "github-issues",
    "catalogId": "roer:catalog/1",
    "components": [
      { "id": "root", "component": "Card", "child": "body" },
      { "id": "body", "component": "Column", "children": ["heading", "list"] },
      { "id": "heading", "component": "Text", "text": "Open issues" },
      { "id": "list", "component": "List", "children": { "path": "/issues", "componentId": "issue" } },
      { "id": "issue", "component": "CheckBox", "label": { "path": "title" }, "value": { "path": "done" } }
    ],
    "dataModel": { "issues": [{ "title": "#42 flaky test", "done": false }] }
  }
}
```

**`updateComponents`** — adds or replaces components by `id` on a surface
that exists, so you can stream a tree in over several messages.

**`updateDataModel`** — sets `value` at `path` (a JSON Pointer such as
`/issues/0/done`). Without `path` it replaces the whole data model. `value`
is required; `null` deletes the key.

```json
{ "version": "v1.0", "updateDataModel": { "surfaceId": "github-issues", "path": "/issues/0/done", "value": true } }
```

**`deleteSurface`** — removes it. Sending `createSurface` again for a
surface that is on screen replaces it.

## Values, paths and lists

Most text, number and boolean props take a literal, a `{ "path": … }`
binding into the data model, or a `{ "call": … }`. Paths are JSON Pointers:
`/issues/0/title`, with `~1` for a `/` and `~0` for a `~` inside a key.

A `children` list is either fixed ids (`["a", "b"]`) or a template:
`{ "path": "/issues", "componentId": "issue" }` renders `issue` once per
element. Inside it, a path without the leading `/` (`"title"`) is relative
to that element, and `{ "call": "@index" }` is its 0-based position
(`"args": { "offset": 1 }` for 1-based).

Inputs write back through their binding: a `CheckBox` whose `value` is
`{ "path": "done" }` flips that element's `done`.

`@index` is the only function so far. The rest of A2UI's basic catalog
(`formatString`, `and`/`or`/`not`, checks) is not wired up yet, and any
other `call` resolves to nothing.

## The component catalog

This is the whole catalog — there is no escape hatch to arbitrary markup, by
design. Every component also takes `accessibility`
(`{ label?, description?, live?, hidden? }`, where `hidden` hides it from
screen readers only) and `weight` (flex-grow inside a `Row`/`Column`).

| Component | Fields | Notes |
| --- | --- | --- |
| **Layout** | | |
| `Row` | `children`, `justify?`, `align?` | `justify`: `start`, `center`, `end`, `spaceBetween`, `spaceAround`, `spaceEvenly`, `stretch`. `align`: `start`, `center`, `end`, `stretch`. |
| `Column` | `children`, `justify?`, `align?` | Same values as `Row`. |
| `List` | `children`, `direction?`, `align?` | Scrolls when it overflows. `direction` is `vertical` (default) or `horizontal`. |
| `Card` | `child: id` | One child; wrap several in a `Column`. |
| `Tabs` | `tabs: [{title, child: id}]` | Which tab is active is client-only state. |
| `Modal` | `trigger: id`, `content: id` | Clicking the trigger opens it; client-only state. |
| `Divider` | `axis?` | `horizontal` (default) or `vertical`. |
| **Display** | | |
| `Text` | `text`, `variant?` | `variant`: `h1`–`h5` for headings (a surface's title is `h2`, a section's `h3`), `caption` for secondary text, `body` (default). |
| `Image` | `url`, `description?`, `fit?`, `variant?` | `description` is the alt text. `variant`: `icon`, `avatar`, `smallFeature`, `mediumFeature`, `largeFeature`, `header`. |
| `Icon` | `name` | Rendered as text for now, or `{ "svgPath": "…" }` for a 24×24 path. |
| `Video` | `url`, `posterUrl?` | |
| `AudioPlayer` | `url`, `description?` | |
| **Input** | | |
| `Button` | `child: id`, `action`, `variant?` | The label is a child, usually a `Text`. `variant`: `default`, `primary`, `borderless`. |
| `TextField` | `label?`, `value?`, `placeholder?`, `variant?`, `action?` | `variant`: `shortText` (default), `longText`, `number`, `obscured`, `search` (a rounded box with a magnifier). Without `label` it is a bare box, e.g. a filter over a list; give it a `placeholder` or `accessibility.label`. `action` is sent when Enter is pressed in a one-line field, with the bound `value` in its context like a `Button`'s. |
| `CheckBox` | `label`, `value` | |
| `ChoicePicker` | `options: [{label, value}]`, `value`, `variant?`, `label?`, `displayStyle?`, `filterable?` | `value` holds an array of the selected `value`s. `variant`: `mutuallyExclusive` (default) or `multipleSelection`. `displayStyle`: `checkbox` or `chips`. |
| `Slider` | `max`, `value`, `min?`, `steps?`, `label?` | |
| `DateTimeInput` | `value`, `enableDate?`, `enableTime?`, `min?`, `max?`, `label?` | Both flags default off; set the ones you want. |
| **Roer's own** | | |
| `Arrow` | `direction?`, `label?` | A connector line with an arrowhead, `horizontal` (default) or `vertical`. It flows inline like `Divider`, so place it between the things it connects inside a `Row`/`Column`. |
| `Expandable` | `title`, `child: id`, `defaultExpanded?` | A collapsible section. Nest these for a tree. |
| `Badge` | `text`, `tone?` | A short label in a pill: a status letter, a count, a state. `tone`: `neutral` (default), `accent`, `success`, `warning`, `danger`; bind it to colour each item of a template. |
| `EmptyState` | `text`, `detail?`, `variant?`, `footer?: id` | What shows in place of content: `empty` (default, nothing to show), `loading` (with a spinner), `error`. It fills the room it is given and centres itself. `footer` holds a control, e.g. a Retry `Button`. Send it as the content while you fetch, then replace it with an `updateComponents`. |
| `Table` | `columns: [{key, title, align?, width?, mono?}]`, `rows`, `toneKey?`, `emptyText?` | Rows of records under column headings: a log, a list of jobs, anything with the same fields per row. Each cell is the row's field `key`, shown as text. `align: "end"` for numbers, `width` in px (the rest share what is left), `mono` for times, ids, paths and codes. `rows` is a list, best bound to the data model. With `toneKey`, a row whose field of that name reads as failed (`failed`, `error`…) is drawn red, and as blocked (`waiting`, `on hold`) amber. Use it instead of a `List` of `Row`s whenever the columns should line up. |
| `DiffView` | `diff`, `title?`, `layout?`, `emptyText?`, `notes?`, `noteActions?`, `noteEvent?` | The Changes tab's diff viewer: a file tree beside the selected file's diff, with highlighting and arrow-key stepping. `diff` is the whole output of `git diff` (any range, any number of files), best bound to the data model. `layout` is `unified` (default) or `split`. `notes` is a list of `{ path, line?, side?, text, tone? }`, each drawn under its line: `line` counts in the new file, or in the old one with `side: "old"` (for a removed line); without `line` the note heads the file. A note with an `author` is a comment: its `text` is markdown, and it may carry `replies: { author, text }[]`, a `tag` ("outdated") and an https `url`. Give notes an `id` and the view `noteActions: { label, value, input?, primary?, done? }[]` and each such note gets a button per action; one with `input` (its placeholder) asks for words first. An answer is reported as the event `noteEvent` (default `diffNote`) with context `{ id, path, line, side, action, text? }`, `action` being the `value`, or `""` when the user takes their answer back. Keep it by setting the note's `state` to that value (and `answer` to the words): an answered note shows `done` in place of its buttons. A note's own `actions` replace `noteActions` for that note, so one diff can offer "Delete" on some notes and "Accept"/"Decline" on others. It needs room: use it as `root` or in a `Column`, not inside a `Card` or a `List`. |
| `WorkItem` | `title`, `source?`, `key?`, `status?`, `url?`, `assignee?`, `labels?`, `meta?`, `footer?: id` | One task from any tracker, drawn the same way whatever it came from. `source` is `github`, `youtrack`, `notion`, `jira` or `personal` (any other name is shown as sent); `key` is the tracker's id (`#21`, `RO-12`, `T-3`); an `https` `url` makes the title open it. The status is coloured by meaning, so `closed`, `Fixed` and `done` all read as finished, and `failed` or `error` as failed. `footer` holds controls, usually a `Row` of `Button`s. With `variant: "detail"` it opens the item up: see *One work item in detail* below. |
| `Requirements` / `Findings` / `Decisions` / `Sources` / `Comments` | `items` | One section of a detailed work item on its own, `items` shaped as there. |

## Boards of work items

A board is lanes of `WorkItem`s: a `Row` of `Column`s, each with a heading
and a `List` templated over its lane in the data model. Map every tracker's
items to the same fields — `{ source, key, title, status, url, labels,
assignee }` — so one template draws them all.

```json
{ "id": "root", "component": "Row", "children": ["todo", "doing", "done"] },
{ "id": "todo", "component": "Column", "weight": 1, "children": ["todo-h", "todo-list"] },
{ "id": "todo-h", "component": "Text", "text": "To do" },
{ "id": "todo-list", "component": "List", "children": { "path": "/lanes/todo", "componentId": "item" } },
{ "id": "item", "component": "WorkItem", "source": { "path": "source" }, "key": { "path": "key" },
  "title": { "path": "title" }, "status": { "path": "status" }, "url": { "path": "url" },
  "labels": { "path": "labels" }, "footer": "item-actions" }
```

GitHub issues come from `gh issue list --json number,title,state,url,labels,assignees`
(`key` `"#" + number`, `status` the state or the project column). **Personal
tasks** live in this project's task store: `add_task`, `update_task`,
`list_tasks` and `delete_task` (or `roer task add|list|set|rm`). Their
statuses are `todo`, `doing` and `done`, and their `key` is their `id`. When
the user asks you to note something to do, add a task; draw it with `source:
"personal"`. The panel does not watch the store: after changing a task, send
an `updateDataModel` for the lanes it moved between. A button that moves a
task sends its id, e.g. `"context": { "id": { "path": "key" }, "to": "done" }`,
and on reading that click you call `update_task` and then update the board.

## One work item in detail

`"variant": "detail"` draws one item, not a board: the card's header, then
its `goal`, then what needs the user (open decisions and findings), then
`requirements`, `sources` and `changes`. Bind each to the item in the data
model; every list is optional.

- `requirements`: `{ id, text, met }[]`, a checklist the user can tick.
- `sources`: `{ kind, label, url?, path? }[]`, where `kind` is `ticket`,
  `slack`, `doc` or `file`. A `path` (project-relative) opens in Roer's file
  viewer, an `https` `url` in the browser.
- `changes`: `{ id, title, patch, notes? }[]`, each drawn with `DiffView`;
  `patch` is a whole `git diff`, `notes` as `DiffView`'s.
- `comments`: `{ id, author, text, at? }[]`, read-only — a YouTrack ticket's
  or a GitHub issue's discussion thread, oldest first. `at` is shown as
  sent (a timestamp or "2h ago"); there is nothing here to write back.
- `findings`: `{ id, severity, text, at?, state? }[]`, `severity` `info`,
  `warn` or `error`, `state` `open` (default), `resolved` or `dismissed`.
  `at` is `{ changeId, path, line, side? }`: an open finding is also drawn
  under that line of the change, and clicking its location shows it there.
- `decisions`: `{ id, question, options: { label, value }[], answer? }[]`.
  The user picks an option or writes their own answer.

```json
{ "id": "root", "component": "WorkItem", "variant": "detail",
  "key": { "path": "/item/key" }, "title": { "path": "/item/title" },
  "status": { "path": "/item/status" }, "goal": { "path": "/item/goal" },
  "requirements": { "path": "/item/requirements" }, "sources": { "path": "/item/sources" },
  "changes": { "path": "/item/changes" }, "findings": { "path": "/item/findings" },
  "decisions": { "path": "/item/decisions" } }
```

What the user does arrives through `read_ui_actions` like a click, with the
item's `key` as `workItem`:

- `toggleRequirement` `{ workItem, id, met }`
- `settleFinding` `{ workItem, id, state }`
- `answerDecision` `{ workItem, id, answer }`, `answer` an option's `value`
  or the user's own words

The panel shows the user's answer straight away but does not write it into
the data model. Record it in yours and send it back with an
`updateDataModel`. Until you send something new for that field, resending
the old value leaves the user's answer on screen. The status is yours alone:
use `planning`, `working`, `blocked`, `review` or `done`.

## Button clicks

A `Button`'s `action` is `{ "event": { "name": "refresh", "context": { … } } }`.
`context` values may be bindings; they are resolved at click time, so bind
exactly what you need to read back:

```json
{ "id": "go", "component": "Button", "child": "go-label",
  "action": { "event": { "name": "apply", "context": { "issues": { "path": "/issues" } } } } }
```

`read_ui_actions` returns the clicks waiting for the session, one per line,
each consumed as it is read:

```json
{"pane":"%9","message":{"version":"v1.0","action":{"name":"apply","surfaceId":"github-issues","sourceComponentId":"go","timestamp":"2026-09-22T00:00:00Z","context":{"issues":[{"title":"#42 flaky test","done":true}]}}}}
```

If `createSurface` set `"sendDataModel": true`, each line also carries the
surface's whole `dataModel` beside the message. It only reports what
happened; decide yourself what to do next, e.g. fetch fresh data and send an
`updateDataModel`. An empty result means nothing has been clicked yet.

In a Claude Code or Junie session Roer started, you need not ask: the clicks reach
you by themselves, these same lines, at each tool call and at the end of a
turn. They are taken as they are handed to you, so act on them rather than
reading again.
