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

   __SIGNING__ Until notarization is in place, macOS quarantines the app on
   first launch and it is killed instead of opening. The command above is the
   fix; it is not optional.
3. Open Roer once. It puts the `roer` command on your `PATH`; in a new
   terminal, `roer help`.

The app carries `roer` and the tmux it drives, so there is nothing else to
install, Homebrew included. It links `roer` into `~/.local/bin`, where Claude
Code's installer puts `claude`; if your shell cannot find it there, the app
asks once for your password and links it into `/usr/local/bin` instead.

## Linux

The `roer` command alone, with tmux 3.3 or later installed yourself:

```sh
mkdir -p ~/.roer/bin ~/.local/bin
curl -fsSL https://github.com/JetBrains/roer/releases/download/__TAG__/roer-cli-__VERSION__-linux-x86_64.tar.gz \
  | tar -xzf - -C ~/.roer/bin
ln -sf ~/.roer/bin/roer ~/.local/bin/roer
roer help
```

`roer` looks for `roer-tmux.conf` beside itself, so the two cannot be split
up — `roer help` succeeding is what proves the config was found.

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
