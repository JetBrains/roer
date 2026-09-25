Roer's Generative UI: a panel beside a Roer session's terminal that draws UI
from a small, fixed catalog of trusted components, never from code you write.
Draft a tree of those components plus the data it reads, and pass the messages
to `show_ui`; Roer shows the panel itself when the first message arrives.

Every message names the `surfaceId` it belongs to — pick one short id per
plugin (e.g. `"github-issues"`) and reuse it across all of a plugin's
messages.

**`surfaceUpdate`** — declares or patches the component tree. `components` is
a flat list, addressed by `id`; a later `surfaceUpdate` for the same
`surfaceId` merges into the existing components rather than replacing them,
so you can stream a tree in over several messages if you want to.

```json
{
  "kind": "surfaceUpdate",
  "surfaceId": "github-issues",
  "root": "card",
  "components": [
    { "id": "card", "type": "Card", "children": ["heading", "list"] },
    { "id": "heading", "type": "Text", "text": "Open issues" },
    { "id": "list", "type": "Card", "children": ["i1"] },
    { "id": "i1", "type": "Checkbox", "label": "#42 flaky test", "checkedPath": "issues.i1" }
  ]
}
```

**`dataModelUpdate`** — merges values into the surface's data model. Anything
a `Checkbox`'s `checkedPath` points at comes from here.

```json
{ "kind": "dataModelUpdate", "surfaceId": "github-issues", "patch": { "issues": { "i1": false } } }
```

**`beginRendering`** — reveals the surface. Nothing shows until this arrives,
even after a `surfaceUpdate` — this is what lets you finish assembling a tree
before the user sees a partial one.

```json
{ "kind": "beginRendering", "surfaceId": "github-issues" }
```

Pass `surfaceUpdate` (and any `dataModelUpdate`s to seed initial state), then
`beginRendering`, last, in one `show_ui` call. To update a surface later, send
another `surfaceUpdate`/`dataModelUpdate` for the same `surfaceId`; there is no
need to `beginRendering` again.

## The component catalog

This is the whole catalog — there is no escape hatch to arbitrary markup, by
design:

| Component | Fields | Notes |
| --- | --- | --- |
| **Layout** | | |
| `Row` | `children: [id]`, `justify?`, `align?` | Horizontal layout. `justify`/`align` are `start`/`center`/`end` (`justify` also takes `spaceBetween`). |
| `Column` | `children: [id]`, `justify?`, `align?` | Vertical layout, same `justify`/`align` values as `Row`. |
| `List` | `children: [id]`, `direction?` | Scrolls when it overflows. `direction` is `vertical` (default) or `horizontal`. |
| **Display** | | |
| `Text` | `text`, `muted?` | `muted: true` for secondary/caption text. |
| `Image` | `url`, `alt?` | |
| `Icon` | `name` | Rendered as text for now; not a real icon set yet. |
| `Divider` | — | A horizontal rule. |
| `Arrow` | `direction?`, `label?` | A connector line with an arrowhead. `direction` is `horizontal` (default) or `vertical`; `label?` sits beside it. Flows inline like `Divider` — it does not reach across the tree to two arbitrary components, so place it directly between the things it connects inside a `Row`/`Column`. |
| **Interactive** | | |
| `Button` | `label`, `action`, `primary?` | `action` is an opaque string your plugin defines and reads back; `primary: true` for the emphasized button. |
| `TextField` | `label`, `valuePath`, `textFieldType?` | `textFieldType` is `shortText` (default), `longText`, `number`, `obscured`, or `date`. `valuePath` is a dotted path into the data model. |
| `Checkbox` | `label`, `checkedPath` | `checkedPath` is a dotted path into the data model. |
| `Slider` | `valuePath`, `minValue`, `maxValue` | |
| `DateTimeInput` | `valuePath`, `enableDate?`, `enableTime?` | Both default `true`; set one `false` for a time-only or date-only picker. |
| `ChoicePicker` | `options: [{label, value}]`, `selectionsPath`, `maxAllowedSelections?` | Multi-select; `selectionsPath` holds an array of selected `value`s. |
| **Container** | | |
| `Card` | `children: [id]` | A container. Nest for grouping/sections. |
| `ButtonRow` | `children: [id]` | A row of `Button`s. |
| `Modal` | `entryPointChild: id`, `contentChild: id` | Clicking the entry point opens the modal; this is client-only state, not a message. |
| `Expandable` | `title`, `child: id`, `defaultExpanded?` | A collapsible section — click the title to toggle. Expanded/collapsed is client-only state, not a message. Nest these for a tree (each row's `child` is another `Expandable` or a `List`). |
| `Tabs` | `tabItems: [{title, child: id}]` | Which tab is active is also client-only state. |

## Button clicks

A `Button`'s `action` only means something if you read it back. `read_ui_actions`
returns the clicks waiting for the session, each consumed as it is read:

```json
{"pane":"%9","surfaceId":"github-issues","name":"refresh","sourceComponentId":"refresh","timestamp":"2026-09-22T00:00:00Z","context":{"watch":{"i1":true}}}
```

`name` is the `Button`'s `action`, and `context` is the surface's whole data
model at click time. It only reports what happened; decide yourself what to do
next, e.g. fetch fresh data and send another `surfaceUpdate`. An empty result
means nothing has been clicked yet.
