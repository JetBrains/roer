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

Draws the whole of `roer:catalog/1`, as Roer's panel does, with what a
terminal cannot do drawn another way:

- Image, Video and AudioPlayer are named and linked rather than shown or played.
- Icon's `svgPath` draws as a mark; a named icon draws as its name.
- Modal opens beneath its trigger, in a frame, rather than over the pane.
- DiffView draws each file's diff with its notes under it, unified only.
- An obscured TextField never shows its value, only its length. The field
  itself cannot mask what is being typed.
- A long TextField is one line.

Beyond A2UI v1.0, and not in Roer's panel yet, the pane can work without a
turn of Claude's, which is where the waiting was (`hooks/local.ts`):

- A `loadData` message fills a data-model path from a command's output (argv,
  no shell) or a file, so Claude names where a diff or a list comes from
  instead of writing it out.
- `createSurface { hidden: true }` keeps a surface without drawing it.
- A Button's `action.local` opens another surface in place of its own and
  fills loads, off the pressed item, in the pane itself. An `event` beside it
  still reaches Claude.

Commands, and files (read as `cat`), run under the person's permissions, as
Claude's own Bash calls do: what their rules and mode allow runs at once, what
needs asking opens the permission dialog when the call lands or the button is
pressed, and what they deny is refused. So a button may merge a PR, and the
pane marks it "(asks first)" when it will ask, or "(not allowed)". An allowed
command runs directly rather than as a Bash tool call; PreToolUse hooks see
only the ones that ask. Either way its output comes whole: what the Bash tool
keeps in a file for being too long for Claude is read from there.

A DiffView draws each file under a header that opens and closes it, and
colours the code by the file's path. The engine refuses a drawing of more
than 100000 characters of text, so the diffs on screen share about 60000:
files are open while they fit, one the person opens takes the room first, and
one that does not fit says so. A file longer than one `Code` takes (10000
characters) is drawn in pieces, cut between hunks.

The pane keeps its own state, as Roer's panel does: the tab showing, what is
expanded or open, a picker's filter, and a work item's ticks and answers.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate claude-plugin/roer-ui
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test claude-plugin/roer-ui
```

For `tsc -p claude-plugin/roer-ui`, write the API's declarations first with
`/plugin-types claude-plugin/roer-ui/.claude/types` in a session that has the
flag set.
