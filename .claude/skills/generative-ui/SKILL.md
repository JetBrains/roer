---
name: generative-ui
description: Draft a plugin's UI as A2UI-shaped JSON and show it live in Roer's Plugin UI tab. Use when the user asks you to build, add, show or update a plugin's UI (e.g. "add a GitHub issues monitor") from a session running inside Roer.
---

# Build a plugin UI and show it live

Roer renders UI from a small, fixed catalog of trusted components — never
from code you write. You draft a tree of those components plus the data it
reads, hand each message to `roer plugin-ui`, and Roer's own renderer
(`src/generative-ui/`) draws it in the session's **Plugin UI** tab, live,
while you keep working.

## Do this

For each message, pipe its JSON on stdin:

```sh
echo '<one JSON message>' | roer plugin-ui
```

This only works from inside a roer session's terminal (it reads the pane from
`$TMUX_PANE`) — the same requirement as `roer handoff`. There is no claim, ack
or timeout: the message either lands in the tab or it doesn't, so check `$?`
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
| `Card` | `children: [id]` | A container. Nest for grouping/sections. |
| `Text` | `text`, `muted?` | `muted: true` for secondary/caption text. |
| `Divider` | — | A horizontal rule. |
| `Checkbox` | `label`, `checkedPath` | `checkedPath` is a dotted path into the data model. |
| `ButtonRow` | `children: [id]` | A row of `Button`s. |
| `Button` | `label`, `action`, `primary?` | `action` is an opaque string your plugin defines and reads back; `primary: true` for the emphasized button. |

Read [`src/generative-ui/schema.ts`](../../src/generative-ui/schema.ts) if you
want the exact types, and
[`src/generative-ui/fixtures.ts`](../../src/generative-ui/fixtures.ts) for a
full worked example (an approval-gate surface) in the same shape.

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

After the last command, tell the user it's up — Roer switches to the Plugin
UI tab itself once a message for their pane arrives.

To update the surface later (e.g. after actually fetching issues), send
another `surfaceUpdate`/`dataModelUpdate` pair for the same `surfaceId`; no
need to `beginRendering` again.
