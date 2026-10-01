<img src="src-tauri/icons/128x128@2x.png" width="64" height="64" alt="Roer icon">

# roer

Session host for agent terminals — a session moves freely between a terminal and the Roer app without restarting.
Latest build: [v0.7.3](https://github.com/JetBrains/roer/releases/tag/v0.7.3).

## Install

1. Download `Roer_<version>_universal.dmg` from the [release](https://github.com/JetBrains/roer/releases/tag/v0.7.3) (one build, Apple silicon + Intel, macOS 15+).
2. Drag `Roer.app` to Applications, then clear its quarantine flag: `xattr -dr com.apple.quarantine /Applications/Roer.app`.
3. Open Roer once. It puts the `roer` command on your `PATH`, and a new terminal can run `roer shell`.

The quarantine step is required — the app is killed on first launch without it. Nothing else to install: the app carries `roer` and the tmux it drives. On launch it links `roer` into `~/.local/bin`, where Claude Code's installer puts `claude`. If your shell cannot find it there, the app asks once for your password and links it into `/usr/local/bin` instead. A `roer` you installed yourself as a regular file is left alone.

### MCP server

`roer mcp` is Roer's MCP server, on stdio. Its tools show a UI in a session's Generative UI panel and read back the clicks on it:

- **In a Roer session** (Claude Code run in a Roer terminal): `show_ui` and `read_ui_actions` act on that session, and `save_ui`/`load_ui` keep UIs with the project.
- **Any other MCP client** it is added to by hand: `show_ui` and `read_ui_actions` only, each naming the session to act on.
- **Claude Code in a plain terminal**: nothing. The server connects but offers no tools and no instructions, so that session carries none of Roer in its context.

The first time the app finds Claude Code, it asks whether to set this and the skill below up, explaining each; **Roer › Claude Code Integration…** asks again later, and unticking one there removes it. Set up, it is registered with Claude Code as `roer` (`claude mcp add-json --scope user`). It leaves the Claude app alone; `roer mcp install --client claude-desktop` adds it there (restart the Claude app to pick it up).

- `roer mcp status` says where it is registered.
- `roer mcp install` registers it yourself, or after an uninstall.
- `roer mcp uninstall` removes roer's entries. Removing the entry in the client itself also sticks.

### Skills

Roer's Claude Code skill `roer-handoff` (in `.claude/skills`) ships with `roer`. Set up from the app, as above, it is linked into `~/.claude/skills`, so a session in any project can hand itself over. The link points into the app, so updating Roer updates it; the app never installs anything you have not said yes to.

- `roer skills` lists them and whether each is installed.
- `roer skills install` installs them yourself: from the Linux or Windows CLI, or after an uninstall.
- `roer skills uninstall` removes them. Deleting one link by hand also sticks: the app never reinstalls a skill you removed.

A skill of the same name that you made yourself is never replaced or removed, and neither is a `roer` MCP entry you wrote yourself. Before deleting Roer.app, run `roer skills uninstall` and `roer mcp uninstall`; afterwards, `rm ~/.claude/skills/roer-handoff` and `claude mcp remove --scope user roer`.

### From a checkout

`cargo build --manifest-path cli/Cargo.toml` builds `roer` into `cli/target/debug/roer`; a debug build finds `scripts/roer-tmux.conf` on its own. `export ROER_BIN=$PWD/cli/target/debug/roer` points `npm run tauri dev` at it.

### Linux

The Linux app is not published to releases yet (the `roer` command is); the `roer-linux` artifact of a [Nightly bundles](../../actions/workflows/nightly-bundles.yml) run has a `.deb`, `.rpm` and `.AppImage`.

1. Install the `.deb` or `.rpm` (it pulls in `tmux`), or install `tmux` yourself and use the `.AppImage`.
2. Unpack `roer-cli-<version>-linux-x86_64.tar.gz` and symlink `roer` onto your `PATH`. Keep `roer`, `roer-tmux.conf` and `skills/` together in the directory you unpack them into: `roer` finds them beside itself. `roer skills install` then links the skills for Claude Code, and `roer mcp install` registers the MCP server with it.
3. Using the AppImage: `export ROER_APP=/path/to/Roer.AppImage`, so `roer handoff` can start the app. The packages install it as `roer-app`, which `roer` finds on its own.

Shortcuts use `Ctrl+Shift` instead of `⌘` (`Ctrl+Shift+T` new session, `Ctrl+Shift+O` Go to File) and `Alt+←`/`Alt+→` to step through commits, leaving plain `Ctrl` keys to the terminal.

### Windows

A preview, natively in PowerShell (no WSL). Sessions run on [psmux](https://github.com/psmux/psmux), a tmux reimplementation on ConPTY. The builds are unsigned, so SmartScreen warns on install.

1. Run `Roer_<version>_x64-setup.exe`. It installs the app and the `roer` command together (`roer.exe` with `psmux.exe`, in the app's `roer\` folder) and adds that folder to your user `PATH`.
2. In a new terminal: `roer shell`, then `M-h` to hand the session to the app.

The `.msi` installs the same files but does not touch `PATH`: add `<install folder>\roer` yourself. `roer-cli-<version>-windows-x64.zip` is the command alone, for use without the app; keep its four files together, since `roer.exe` finds `roer-tmux.conf` and `psmux.exe` beside itself.

Shortcuts are as on Linux. Not there yet on Windows: `C-b` is taken off psmux's prefix but not yet checked with real keypresses. Between releases, the `roer-windows` artifact of a [Nightly bundles](../../actions/workflows/nightly-bundles.yml) run has the installers and the CLI zip.

## Agents

`roer new` starts the default agent in the new session's shell; `roer new --agent <id>` starts another, and `--model`/`--effort` override it once. Every installed CLI is an agent as it comes (`claude`, `codex`, `pi`, `gemini`, `junie`, `opencode`). A saved agent is a Markdown file with YAML frontmatter, the format Claude Code, opencode and Copilot use for their own agents:

```markdown
---
name: Reviewer
description: Careful reviewer for PR feedback
cli: codex              # claude | codex | pi | gemini | junie | opencode | custom
model: gpt-5.5
effort: high            # translated to each CLI's own flag
permissions: ask        # ask | auto | full
args: ["--search"]
---
Review the diff. Report bugs first, style last.
```

`~/.roer/agents/<id>.md` is yours alone; `<project>/.roer/agents/<id>.md` is committed and shared. The body is added to the agent's instructions where the CLI takes extra ones: Claude Code and pi read it from a file, Junie gets it as `--system-prompt` and Codex as `developer_instructions`, both read in by the shell (`$(cat …)`) so the text itself is never typed. Gemini CLI and opencode take none. Keys roer does not know are kept when the app saves the file.

- `roer agents` lists them, `*` marking the default; `roer agents default <id>` changes it (`ROER_AGENT` overrides it for one shell).
- `roer agents command <id>` prints exactly what the agent types into its session.
- `roer resume <id> --agent codex` resumes a Codex conversation; the Resume list shows Codex conversations beside Claude Code's.

## Screenshots

**Generative UI** — a plugin drafts a UI as A2UI v1.0 JSON and shows it live in Roer's panel; save it as a project-local bundle to reload later.

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
- **Agents** — New session starts Claude Code, Codex, pi, Gemini CLI, Junie or opencode; the chevron beside it (`⌥⌘T`) picks one, and **Roer › Agents…** (`⌘,`) saves named setups with a model, reasoning effort, permissions and instructions. See [Agents](#agents).
- **Branch diff view** — browse a branch's commits against its base, step through them, and view each commit's file diff.
- **Pull Request tab** — for the session's branch, through your own `gh` login: let Claude draft the title and description, push and open the PR, request a Copilot review (Roer polls until it lands), then pick review threads and send them to the session with **Fix with Claude**. Under the hood the tab uses `roer send` (type a prompt into a session) and `roer pr-draft` (the agent hands a draft back).
- **tmux-backed sessions** — sessions live in tmux on a private socket, a swappable detail behind the `roer` CLI.
- **Go-to-file** — jump straight to any changed file from the diff view.
- **Keyboard-friendly** — arrow keys and Cmd+arrows step through commits and files without touching the mouse.
