Roer is a session host for agent terminals: `roer shell` starts a terminal you
work in normally, and `M-h` hands that live session over to the desktop app.

Requires **macOS 15** or later. The `.dmg` is a universal build — one download
for Apple silicon and Intel.

## Install

1. Open `Roer___VERSION___universal.dmg` and drag **Roer** to Applications.
2. Clear the quarantine flag:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Roer.app
   ```

   This build is **unsigned**. Until notarization is in place, macOS quarantines the app on
   first launch and it is killed instead of opening. The command above is the
   fix; it is not optional.
3. Open Roer once. It puts the `roer` command on your `PATH`; in a new
   terminal, `roer help`.

The app carries `roer` and the tmux it drives, so there is nothing else to
install, Homebrew included. It links `roer` into `~/.local/bin`, where Claude
Code's installer puts `claude`; if your shell cannot find it there, the app
asks once for your password and links it into `/usr/local/bin` instead.

If Claude Code is installed, the first launch asks whether to set Roer up in
it: the `/roer-handoff` skill, so a session in any terminal can hand itself
over, and `roer mcp`, Roer's MCP server, so an agent in a Roer session can show
a UI in its session's Generative UI panel. **Roer › Claude Code Integration…**
changes the answer later, including taking either one back.

## Linux

The `roer` command alone, with tmux 3.3 or later installed yourself:

```sh
mkdir -p ~/.roer/bin ~/.local/bin
curl -fsSL https://github.com/JetBrains/roer/releases/download/__TAG__/roer-cli-__VERSION__-linux-x86_64.tar.gz \
  | tar -xzf - -C ~/.roer/bin
ln -sf ~/.roer/bin/roer ~/.local/bin/roer
roer help
roer skills install   # optional: Roer's skills for Claude Code, Codex, Pi and Junie
roer mcp install      # optional: Roer's MCP server for Claude Code
```

`roer` looks for `roer-tmux.conf` and `skills/` beside itself, so they cannot
be split up — `roer help` succeeding is what proves the config was found.

## Windows (preview)

Native, in PowerShell: sessions run on [psmux](https://github.com/psmux/psmux),
a tmux reimplementation on ConPTY. The downloads are **unsigned**, so
SmartScreen warns before installing.

1. Run `Roer___VERSION___x64-setup.exe`. It installs the app and the `roer`
   command together, and adds the command's folder to your user `PATH`.
2. In a new terminal, `roer help`, then `roer shell` and `M-h`.

`Roer___VERSION___x64_en-US.msi` installs the same files but leaves `PATH`
alone: add `<install folder>\roer` yourself.
`roer-cli-__VERSION__-windows-x64.zip` is the command without the app; keep
its files together, since `roer.exe` finds `roer-tmux.conf` and `psmux.exe`
beside itself.

## Roer's UI in Claude Code (preview)

`roer-ui-claude-plugin-__VERSION__.zip` is the roer-ui plugin: `/roer <what to
show>` draws Roer's Generative UI in a pane of any Claude Code session, with no
Roer app involved. It is built on Claude Code's early-access function hooks, so
it needs the flag below and may break with a Claude Code update.

```sh
mkdir -p ~/.roer && unzip -o roer-ui-claude-plugin-__VERSION__.zip -d ~/.roer
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ~/.roer/roer-ui
```

## Verify the downloads

```sh
shasum -a 256 -c SHA256SUMS.txt
```

On Windows, compare `Get-FileHash <file>` with its line in `SHA256SUMS.txt`.

## Try it

```sh
roer shell     # a normal terminal
               # press M-h — the terminal lets go and Roer attaches
```
