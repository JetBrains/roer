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
| `Text` | `text`, `variant?` | `variant: "caption"` for secondary text. |
| `Image` | `url`, `description?`, `fit?`, `variant?` | `description` is the alt text. `variant`: `icon`, `avatar`, `smallFeature`, `mediumFeature`, `largeFeature`, `header`. |
| `Icon` | `name` | Rendered as text for now, or `{ "svgPath": "…" }` for a 24×24 path. |
| `Video` | `url`, `posterUrl?` | |
| `AudioPlayer` | `url`, `description?` | |
| **Input** | | |
| `Button` | `child: id`, `action`, `variant?` | The label is a child, usually a `Text`. `variant`: `default`, `primary`, `borderless`. |
| `TextField` | `label`, `value?`, `placeholder?`, `variant?` | `variant`: `shortText` (default), `longText`, `number`, `obscured`. |
| `CheckBox` | `label`, `value` | |
| `ChoicePicker` | `options: [{label, value}]`, `value`, `variant?`, `label?`, `displayStyle?`, `filterable?` | `value` holds an array of the selected `value`s. `variant`: `mutuallyExclusive` (default) or `multipleSelection`. `displayStyle`: `checkbox` or `chips`. |
| `Slider` | `max`, `value`, `min?`, `steps?`, `label?` | |
| `DateTimeInput` | `value`, `enableDate?`, `enableTime?`, `min?`, `max?`, `label?` | Both flags default off; set the ones you want. |
| **Roer's own** | | |
| `Arrow` | `direction?`, `label?` | A connector line with an arrowhead, `horizontal` (default) or `vertical`. It flows inline like `Divider`, so place it between the things it connects inside a `Row`/`Column`. |
| `Expandable` | `title`, `child: id`, `defaultExpanded?` | A collapsible section. Nest these for a tree. |

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
