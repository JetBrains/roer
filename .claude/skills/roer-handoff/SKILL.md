---
name: roer-handoff
description: Teleport the current terminal session into the Roer desktop app. Use when the user asks to open, move, teleport or continue this session in Roer.
---

# Teleport this session into Roer

Move which client is showing this session, from the terminal to the Roer app.
The session and everything running in it — this conversation included — keeps
running throughout. Nothing is restarted.

## Do this

```sh
roer handoff
```

That is the whole happy path. Do not call `tmux` directly and do not try to
find the pane yourself: the shim owns the socket, the pane lookup and the
attach semantics.

On success the terminal detaches and **this conversation continues inside
Roer** — so anything printed after that point appears there, not in the
terminal the user was looking at. Stop; the handoff is done.

## Read the exit code

| Code | Meaning | Do |
| --- | --- | --- |
| 0 | Roer attached; the terminal has let go. | Nothing. It worked. |
| 2 | Not inside a roer session. | Use the fallback below. |
| 3 | Inside tmux, but not Roer's socket. | Use the fallback below. |
| 4 | Roer did not take it within 10 seconds. | Tell the user to start Roer, then retry. The session was left exactly where it was. |

Code 4 is safe by construction: the terminal only detaches after Roer confirms
it is rendering the session, so a failed handoff never leaves a session with
no client and no window showing it.

## Fallback: this terminal cannot be attached

Codes 2 and 3 mean the session was started outside Roer's reach. A process's
controlling terminal cannot be reassigned after the fact on macOS, so the live
terminal genuinely cannot be moved — hand over the *conversation* instead:

```sh
slug=$(pwd | tr -c 'A-Za-z0-9\n' '-')
id=$(basename "$(ls -t ~/.claude/projects/"$slug"/*.jsonl | head -1)" .jsonl)
roer handoff --resume "$id"
```

Every character of the cwd that is not alphanumeric folds to `-` in the
project slug, which is why this uses `tr` and not a slash-only substitution.
The newest transcript in that directory is this conversation; if the user has
several sessions open in the same project, confirm the id with them first.

Roer opens `claude --resume <id> --permission-mode manual` in a fresh roer
session, so the conversation continues and is teleportable from then on. Exit
codes are the same as above, minus 2 and 3.

Manual mode is not optional here. A transcript does not carry the permission
mode it ran under, and a turn that was still in flight when the terminal was
abandoned can resume *acting* the moment it is restored — in whatever mode the
new session happens to default to, which nobody chose for it. Do not add a mode
flag of your own to this command; if the user wants auto, they can switch once
the session is on screen and they can see what it is about to do.

Two things to tell the user afterwards, because this path is not seamless:

- **This terminal's Claude is still running.** The conversation continues in
  Roer, so they should exit this one rather than leave two clients on one
  conversation.
- **To avoid the fallback next time**, start with `roer shell` instead of a
  plain terminal: it gives a shell whose sessions can be teleported, and
  `claude` inside it needs no special treatment. (Bare `roer` opens the session
  in the app straight away, which is the other way to never be in this
  position.)
