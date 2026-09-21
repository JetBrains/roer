# Roer

Session host for agent terminals. A session lives in exactly one client at a
time and moves freely between a terminal and the Roer app, so you can start
`claude` in a terminal and finish looking at it in Roer — the process never
restarts.

macOS 14 or later, for now.

## Download

**[Roer 0.2.0](https://github.com/JetBrains/roer/releases/tag/v0.2.0)** — one
universal build covers Apple silicon and Intel. Grab
`Roer_0.2.0_universal.dmg` and `roer-cli-0.2.0.tar.gz`; all releases are on the
[Releases page](https://github.com/JetBrains/roer/releases).

## Install

1. Drag Roer to Applications, then clear its quarantine flag —
   **required, not optional**; without it the app is killed on first launch:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Roer.app
   ```
2. `brew install tmux`
3. Unpack `roer-cli-<version>.tar.gz` into one directory and symlink `roer`
   onto your `PATH`. Take the tarball rather than the loose assets — release
   assets carry no mode bits, and `roer` must be executable for teleport to
   work at all.

## Features

**Terminal sessions that move.** Run `roer shell` in a terminal, work in it,
then press `M-h` — the terminal lets go, Roer attaches, and whatever was
running keeps running. `M-d` detaches without teleporting, and `roer shell`
from a terminal takes the session back. tmux is the persistence layer, so the
app can restart without losing a session.

**A launcher for everything running.** The sidebar lists live sessions, past
ones, and resumable Claude Code conversations; `Cmd+T` starts one more.
Sessions are named after their directory, so two checkouts that share a name
never collide.

**Go to File** — `Cmd+Shift+O`, IntelliJ's shortcut, works while you are
typing in the terminal. Fuzzy search over every file in the session's
repository; the file opens read-only in its own tab. `App.tsx:42` opens
scrolled to line 42. The index and matcher are both in Rust, so half a million
paths stay interactive.

**Changes** — the worktree against `HEAD`, folder tree on the left, diff on the
right. It updates as the agent edits, rather than when you look at it: one
recursive FSEvents watch per worktree feeds the view live.

**Branch diff** — the commits on your branch, one at a time, with `Cmd+←` and
`Cmd+→` to step through them and each commit's files and diff alongside.

## Documentation

[docs/design.md](docs/design.md) — the long form: why the shim exists, how
activation works on macOS 14, the file index, worktree watching, development
setup, checks, and how releases are cut.
