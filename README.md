# roer

Session host for agent terminals — a session moves freely between a terminal and the Roer app without restarting.
Latest build: [v0.2.0](https://github.com/JetBrains/roer/releases/tag/v0.2.0).

## Install

1. Download `Roer_<version>_universal.dmg` and `roer-cli-<version>.tar.gz` from the [release](https://github.com/JetBrains/roer/releases/tag/v0.2.0) (one build, Apple silicon + Intel, macOS 14+).
2. Drag `Roer.app` to Applications, then clear its quarantine flag: `xattr -dr com.apple.quarantine /Applications/Roer.app`.
3. `brew install tmux`.
4. Unpack the CLI tarball and symlink `roer` onto your `PATH`.

The quarantine step is required — the app is killed on first launch without it. Use the tarball, not the loose binary: release assets carry no mode bits, and `roer` must be executable.

## Screenshots

**Generative UI** — a plugin drafts a UI as A2UI-shaped JSON and shows it live in Roer's panel; save it as a project-local bundle to reload later.

![Generative UI panel](docs/screenshots/Gen%20UI%20artifacts.png)

**Go to File** (`⌘⇧O`) — blazing fast, fuzzy-matched jump to any changed file straight from the diff view.

![Go to File](docs/screenshots/Go%20To%20File.png)

**Teleported `claude` session** — a running session hands off from the terminal to the Roer app without restarting.

![Claude session in Roer](docs/screenshots/claude.png)

**Branch diff view** — step through a branch's commits against its base and view each commit's file diff.

![Branch diff view](docs/screenshots/diff.png)

**Markdown preview** — view rendered Markdown for any changed file straight from the diff view.

![Markdown preview](docs/screenshots/markdown.png)

## Features

- **Session teleport (`M-h`)** — hand a running terminal session (`claude`, `vim`, a dev server) off to the Roer app mid-flight, and back again, with the process never restarting.
- **New session launcher** — one button starts `roer new`; the launcher lists what's already running.
- **Branch diff view** — browse a branch's commits against its base, step through them, and view each commit's file diff.
- **tmux-backed sessions** — sessions live in tmux on a private socket, a swappable detail behind the `roer` CLI.
- **Go-to-file** — jump straight to any changed file from the diff view.
- **Keyboard-friendly** — arrow keys and Cmd+arrows step through commits and files without touching the mouse.
