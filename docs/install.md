# Installing Roer

The app and the `roer` command it drives, on each platform, and the agent integrations it sets up.

## macOS

1. Download `Roer_<version>_universal.dmg` from the [latest release](https://github.com/JetBrains/roer/releases/latest) (one build, Apple silicon + Intel, macOS 14+).
2. Drag `Roer.app` to Applications.
3. Open Roer once. It puts the `roer` command on your `PATH`, and a new terminal can run `roer shell`.

Nothing else to install: the app carries `roer` and the tmux it drives. On launch it links `roer` into `~/.local/bin`, where Claude Code's installer puts `claude`. If your shell cannot find it there, the app asks once for your password and links it into `/usr/local/bin` instead. A `roer` you installed yourself as a regular file is left alone.

## Linux

1. Install the package from the release: `sudo apt install ./Roer_<version>_amd64.deb`, or `sudo dnf install ./Roer-<version>-1.x86_64.rpm`. It installs the app and the `roer` command together (`roer` in `/usr/lib/Roer/cli`, linked as `/usr/bin/roer`) and pulls in tmux, which has to be 3.3 or later: Ubuntu 24.04 or Debian 12 and newer, or a current Fedora.
2. In a new terminal: `roer shell`, then `M-h` to hand the session to the app.

`Roer_<version>_amd64.AppImage` is the same app for any other distribution. Install tmux yourself, make the AppImage executable and open it once: it copies `roer` out of the image to `~/.roer/appimage-cli`, and links it as `~/.local/bin/roer` and the AppImage as `~/.local/bin/roer-app`, which `roer` starts the app by.

`roer-cli-<version>-linux-x86_64.tar.gz` is the command alone, for use without the app. Unpack it and symlink `roer` onto your `PATH`, keeping `roer`, `roer-tmux.conf` and `skills/` together: `roer` finds them beside itself. `roer skills install` then links the skills for Claude Code, Codex, Pi and Junie, and `roer mcp install` registers the MCP server with Claude Code. Between releases, the `roer-linux` artifact of a [Nightly bundles](https://github.com/JetBrains/roer/actions/workflows/nightly-bundles.yml) run has the packages.

Shortcuts use `Ctrl+Shift` instead of `⌘` (`Ctrl+Shift+T` new session, `Ctrl+Shift+O` Go to File) and `Alt+←`/`Alt+→` to step through commits, leaving plain `Ctrl` keys to the terminal.

## Windows

A preview, natively in PowerShell (no WSL). Sessions run on [psmux](https://github.com/psmux/psmux), a tmux reimplementation on ConPTY. The installers, `roer-app.exe` and `roer.exe` are signed by JetBrains.

1. Run `Roer_<version>_x64-setup.exe`. It installs the app and the `roer` command together (`roer.exe` with `psmux.exe`, in the app's `roer\` folder) and adds that folder to your user `PATH`.
2. In a new terminal: `roer shell`, then `M-h` to hand the session to the app.

The `.msi` installs the same files but does not touch `PATH`: add `<install folder>\roer` yourself. `roer-cli-<version>-windows-x64.zip` is the command alone, for use without the app; keep its four files together, since `roer.exe` finds `roer-tmux.conf` and `psmux.exe` beside itself.

Shortcuts are as on Linux. Not there yet on Windows: `C-b` is taken off psmux's prefix but not yet checked with real keypresses. Between releases, the `roer-windows` artifact of a [Nightly bundles](https://github.com/JetBrains/roer/actions/workflows/nightly-bundles.yml) run has the installers and the CLI zip, unsigned, so SmartScreen warns on install.

## Updating

When a newer release is out, the app says so in a corner, and **Update and restart** installs it in place: it downloads the same file you would, checks it against the release's `SHA256SUMS.txt`, and on macOS and Windows installs it only if it is signed by JetBrains (and, on macOS, notarized by Apple). Then the app restarts. On macOS and Linux sessions run in tmux, not in the app, so they keep running. On Linux the .deb or .rpm is installed through `pkexec`, which asks for your password; an AppImage is replaced where it is.

An app opened straight off the .dmg, an `.msi` install, and a Linux package on a system without `pkexec` offer **Download** instead, as does the notice when an install fails.

## MCP server

`roer mcp` is Roer's MCP server, on stdio. Its tools show a UI in a session's Generative UI panel and read back the clicks on it:

- **In a Roer session** (Claude Code run in a Roer terminal): `show_ui` and `read_ui_actions` act on that session, and `save_ui`/`load_ui` keep UIs with the project.
- **Any other MCP client** it is added to by hand: `show_ui` and `read_ui_actions` only, each naming the session to act on.
- **Claude Code in a plain terminal**: nothing. The server connects but offers no tools and no instructions, so that session carries none of Roer in its context.

The first time the app finds Claude Code, it offers agent integrations. **Roer › Agent Integrations…** opens the same controls later: shared extension authoring for Codex, Pi and Junie, plus Claude Code skills and MCP. Set up, the MCP server is registered with Claude Code as `roer` (`claude mcp add-json --scope user`). It leaves the Claude app alone; `roer mcp install --client claude-desktop` adds it there (restart the Claude app to pick it up).

- `roer mcp status` says where it is registered.
- `roer mcp install` registers it yourself, or after an uninstall.
- `roer mcp uninstall` removes roer's entries. Removing the entry in the client itself also sticks.

## Skills

Roer's Claude Code skill `roer-handoff` (in `.claude/skills`) ships with `roer`. Set up from the app, as above, it is linked into `~/.claude/skills`, so a session in any project can hand itself over. The link points into the app, so updating Roer updates it; the app never installs anything you have not said yes to.

`roer skills install` installs both Roer skills for Claude Code and the portable `roer-extension-authoring` skill for Codex, Pi and Junie. The latter three read it from the shared `~/.agents/skills` directory. `--agent claude|codex|pi|junie` selects one target; Codex, Pi and Junie select the same shared installation, so removing it for one removes it for all three. The authoring skill tells agents to create extension drafts outside the project's source tree. The `roer ext` CLI works without an MCP connection.

- `roer skills` lists them and whether each is installed.
- `roer skills install` installs them yourself: from the Linux or Windows CLI, or after an uninstall.
- `roer skills uninstall` removes them. Deleting one link by hand also sticks: the app never reinstalls a skill you removed.

A skill of the same name that you made yourself is never replaced or removed, and neither is a `roer` MCP entry you wrote yourself. Before deleting Roer.app, run `roer skills uninstall` and `roer mcp uninstall`; afterwards, `rm ~/.claude/skills/roer-handoff` and `claude mcp remove --scope user roer`.

## From a checkout

`cargo build --manifest-path cli/Cargo.toml` builds `roer` into `cli/target/debug/roer`; a debug build finds `scripts/roer-tmux.conf` on its own. `export ROER_BIN=$PWD/cli/target/debug/roer` points `npm run tauri dev` at it.

Running Roer on a server, for a browser tab: [self-hosting.md](self-hosting.md). Saved agents: [saved-agents.md](saved-agents.md).
