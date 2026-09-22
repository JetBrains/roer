---
name: generative-ui
description: Draft a plugin's UI as A2UI-shaped JSON and show it live in Roer's Generative UI panel. Use when the user asks you to build, add, show or update a plugin's UI (e.g. "add a GitHub issues monitor") from a session running inside Roer.
---

# Build a plugin UI and show it live

Roer renders UI from a small, fixed catalog of trusted components — never
from code you write. You draft a tree of those components plus the data it
reads, hand each message to `roer plugin-ui`, and Roer's own renderer
(`src/generative-ui/`) draws it in the session's **Generative UI** panel — a
column beside the terminal, not a tab that replaces it — live, while you keep
working. Roer expands the panel itself once a message for the session's pane
arrives.

## Do this

For each message, pipe its JSON on stdin:

```sh
echo '<one JSON message>' | roer plugin-ui
```

This only works from inside a roer session's terminal (it reads the pane from
`$TMUX_PANE`) — the same requirement as `roer handoff`. There is no claim, ack
or timeout: the message either lands in the panel or it doesn't, so check `$?`
and stderr, not a side effect elsewhere.

## The three message kinds

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

Send `surfaceUpdate` (and any `dataModelUpdate`s to seed initial state), then
`beginRendering`, last.

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

Read [`src/generative-ui/schema.ts`](../../../src/generative-ui/schema.ts) if
you want the exact types, and
[`src/generative-ui/fixtures.ts`](../../../src/generative-ui/fixtures.ts) for
a full worked example (an approval-gate surface) in the same shape.

## Worked example: "add a GitHub issues monitor"

```sh
echo '{
  "kind": "surfaceUpdate",
  "surfaceId": "github-issues",
  "root": "card",
  "components": [
    { "id": "card", "type": "Card", "children": ["heading", "sub", "divider", "list", "row"] },
    { "id": "heading", "type": "Text", "text": "GitHub issues monitor" },
    { "id": "sub", "type": "Text", "muted": true, "text": "Watching anthropics/roer for new issues." },
    { "id": "divider", "type": "Divider" },
    { "id": "list", "type": "Card", "children": ["i1", "i2"] },
    { "id": "i1", "type": "Checkbox", "label": "#42 flaky test in watch.rs", "checkedPath": "watch.i1" },
    { "id": "i2", "type": "Checkbox", "label": "#57 handoff race on quit", "checkedPath": "watch.i2" },
    { "id": "row", "type": "ButtonRow", "children": ["refresh"] },
    { "id": "refresh", "type": "Button", "label": "Refresh", "action": "refresh", "primary": true }
  ]
}' | roer plugin-ui

echo '{"kind": "dataModelUpdate", "surfaceId": "github-issues", "patch": {"watch": {"i1": true, "i2": true}}}' \
  | roer plugin-ui

echo '{"kind": "beginRendering", "surfaceId": "github-issues"}' | roer plugin-ui
```

After the last command, tell the user it's up — Roer expands the Generative
UI panel itself once a message for their pane arrives.

To update the surface later (e.g. after actually fetching issues), send
another `surfaceUpdate`/`dataModelUpdate` pair for the same `surfaceId`; no
need to `beginRendering` again.

## Reading back a button click

A `Button`'s `action` is only meaningful if something reads it. When a person
clicks one in the Generative UI panel, Roer reports it — in the same shape
A2UI's own client-to-server `action` message uses — to whichever pane's
terminal is watching:

```sh
roer plugin-ui-actions
```

This prints any pending actions for this session's pane, one JSON object per
line, and consumes them (nothing is left to read twice):

```json
{"pane":"%9","surfaceId":"github-issues","name":"refresh","sourceComponentId":"refresh","timestamp":"2026-09-22T00:00:00Z","context":{"watch":{"i1":true,"i2":false}}}
```

`name` is the `Button`'s `action` string, `sourceComponentId` is the id of
the `Button` itself, and `context` is the surface's whole data model at click
time — so you can see which checkboxes were on without a separate query.

There's no reply channel: this only tells you what happened, it doesn't ask
you to do anything. Decide what to do next yourself — e.g. actually refresh
the issues and send an updated `surfaceUpdate`. If nothing is waiting, the
command prints nothing and exits `0`; poll it (e.g. after telling the user
you're waiting for a click) rather than assuming one arrived.

## Saving a plugin UI to use again

Once a surface is good, save it under the project's `.roer/plugin-ui/` so it
can be shown again later — by you in a future session, or by a person picking
it from the Generative UI panel's own list — without rebuilding it from
scratch. Save it once the person is satisfied, not automatically after every
message.

```sh
echo '{
  "kind": "surfaceUpdate",
  "surfaceId": "github-issues",
  "root": "card",
  "components": [
    { "id": "card", "type": "Card", "children": ["heading", "list"] },
    { "id": "heading", "type": "Text", "text": "Open issues" },
    { "id": "list", "type": "Card", "children": ["i1"] },
    { "id": "i1", "type": "Checkbox", "label": "#42 flaky test", "checkedPath": "issues.i1" }
  ]
}' | roer plugin-ui save github-issues surfaceUpdate

echo '{"kind": "dataModelUpdate", "surfaceId": "github-issues", "patch": {"issues": {"i1": false}}}' \
  | roer plugin-ui save github-issues dataModelUpdate

roer plugin-ui save github-issues prompt "Add a GitHub issues monitor"
```

The three pieces land as small, separate files under
`.roer/plugin-ui/bundles/github-issues/` — commit them like any other project
file so the bundle travels with the code it belongs to.

To show it again later, in this session or a new one:

```sh
roer plugin-ui load github-issues
```

This re-sends the saved `surfaceUpdate` (and `dataModelUpdate`, if one was
saved), then `beginRendering` — the same sequence you'd send live, just read
back from disk. There's no partial-update form for `save`: saving again under
the same name overwrites that piece of the bundle.

## House style: `.roer/plugin-ui/style-guide.md`

Before drafting a new surface, check for `.roer/plugin-ui/style-guide.md` in
the project. If it exists, follow its conventions — this is where a project
accumulates its own opinions about composing with the fixed catalog (there's
no CSS to write; this is prose guidance, not a stylesheet). If it doesn't
exist and the person asks you to establish or change house style, create or
edit it. A reasonable starting point:

```markdown
# Generative UI style guide

- One `primary` button per surface at most — it's the one action you want a
  glance to land on.
- Use `muted` `Text` for secondary detail (counts, timestamps, captions),
  plain `Text` for anything the person needs to read first.
- Prefer `Card` over bare `Column`/`Row` for anything that reads as one
  logical group — it's what gives a surface visible structure at a glance.
- Keep a surface to one clear next action. If it needs more than one, use
  `ButtonRow` rather than scattering buttons through the tree.
```
