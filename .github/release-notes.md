Roer is a session host for agent terminals: `roer shell` starts a terminal you
work in normally, and `M-h` hands that live session over to the desktop app.

Requires **macOS 14** or later. The `.dmg` is a universal build — one download
for Apple silicon and Intel.

## Install the app

1. Open `Roer___VERSION___universal.dmg` and drag **Roer** to Applications.
2. Clear the quarantine flag:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Roer.app
   ```

   __SIGNING__ Until notarization is in place, macOS quarantines the app on
   first launch and it is killed instead of opening. The command above is the
   fix; it is not optional.

## Install tmux

tmux is roer's session engine and is **not** bundled. 3.3 or later, for
`allow-passthrough`:

```sh
brew install tmux
```

## Install the `roer` command

```sh
mkdir -p ~/.roer/bin ~/.local/bin
curl -fsSL https://github.com/JetBrains/roer/releases/download/__TAG__/roer-cli-__VERSION__.tar.gz \
  | tar -xzf - -C ~/.roer/bin
ln -sf ~/.roer/bin/roer ~/.local/bin/roer
roer help
```

`tar` keeps `roer` and `roer-tmux.conf` in one directory, and `curl` does not
set the quarantine flag a browser download would. `roer` looks for
`roer-tmux.conf` beside itself, so the two cannot be split up — `roer help`
succeeding is what proves the config was found.

`~/.local/bin` is not just about `PATH`. An app launched from Finder inherits
only `/usr/bin:/bin:/usr/sbin:/sbin`, so Roer looks for `roer` at
`~/.local/bin/roer` and `~/bin/roer` when it is not on the inherited `PATH`.

On Linux, take `roer-cli-__VERSION__-linux-x86_64.tar.gz` instead; the steps
are the same.

## Windows (preview)

Native, in PowerShell: sessions run on [psmux](https://github.com/psmux/psmux),
a tmux reimplementation on ConPTY, which ships inside the CLI zip. Both
downloads are **unsigned**, so SmartScreen warns before installing.

1. Run `Roer___VERSION___x64-setup.exe` (or `Roer___VERSION___x64_en-US.msi`).
2. Unzip `roer-cli-__VERSION__-windows-x64.zip` into a folder of its own and
   add that folder to your user `PATH`:

   ```powershell
   $bin = "$env:USERPROFILE\.roer\bin"
   Expand-Archive roer-cli-__VERSION__-windows-x64.zip -DestinationPath $bin -Force
   [Environment]::SetEnvironmentVariable('Path', "$bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')
   ```

   Keep the files together: `roer.exe` finds `roer-tmux.conf` and `psmux.exe`
   beside itself.
3. In a new terminal, `roer help`, then `roer shell` and `M-h`.

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
