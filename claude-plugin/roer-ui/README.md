# roer-ui (spike)

Roer's Generative UI drawn in a Claude Code pane, beside the transcript, with no
Roer app or tmux involved: `/roer <what to show>` opens the pane and asks Claude
to draw it through this mod's own `show` tool, which takes the same A2UI v1.0
messages as Roer's `show_ui`. Presses come back to Claude as a prompt starting
`[roer-ui]`, with the action message and, under `sendDataModel`, the data model.

It is a Claude Code *function hooks* plugin: early access, off unless
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, and the API may change between releases.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir claude-plugin/roer-ui
# then: /roer a form to file a bug
```

Draws Column, Row, List, Card, Tabs, Divider, Text, Button, TextField,
CheckBox and ChoicePicker; the rest of `roer:catalog/1` shows as a placeholder.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate claude-plugin/roer-ui
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test claude-plugin/roer-ui
```

For `tsc -p claude-plugin/roer-ui`, write the API's declarations first with
`/plugin-types claude-plugin/roer-ui/.claude/types` in a session that has the
flag set.
