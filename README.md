# roer

Session host for agent terminals — a session moves freely between a terminal and the Roer app without restarting.
Latest build: [v0.2.0](https://github.com/JetBrains/roer/releases/tag/v0.2.0).

## Install

1. Download `Roer_<version>_universal.dmg` and `roer-cli-<version>.tar.gz` from the [release](https://github.com/JetBrains/roer/releases/tag/v0.2.0) (one build, Apple silicon + Intel, macOS 14+).
2. Drag `Roer.app` to Applications, then clear its quarantine flag: `xattr -dr com.apple.quarantine /Applications/Roer.app`.
3. `brew install tmux`.
4. Unpack the CLI tarball and symlink `roer` onto your `PATH`.

The quarantine step is required — the app is killed on first launch without it. Use the tarball, not the loose binary: release assets carry no mode bits, and `roer` must be executable.

## Features

- **Session teleport (`M-h`)** — hand a running terminal session (`claude`, `vim`, a dev server) off to the Roer app mid-flight, and back again, with the process never restarting.
- **New session launcher** — one button starts `roer new`; the launcher lists what's already running.
- **Branch diff view** — browse a branch's commits against its base, step through them, and view each commit's file diff.
- **tmux-backed sessions** — sessions live in tmux on a private socket, a swappable detail behind the `roer` CLI.
- **Go-to-file** — jump straight to any changed file from the diff view.
- **Keyboard-friendly** — arrow keys and Cmd+arrows step through commits and files without touching the mouse.
