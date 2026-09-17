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

Take the tarball rather than the loose files: `tar` preserves the executable bit
and keeps `roer` and `roer-tmux.conf` in one directory, and `curl` does not set
the quarantine flag a browser download would. The two files find each other by
directory, so they cannot be split up — `roer help` succeeding is what proves
`roer-tmux.conf` was found beside the shim.

`~/.local/bin` is not just about `PATH`. An app launched from Finder inherits
only `/usr/bin:/bin:/usr/sbin:/sbin`, so Roer looks for the shim at
`~/.local/bin/roer` and `~/bin/roer` when it is not on the inherited `PATH`.

The loose `roer` and `roer-tmux.conf` are attached for reading. Release assets
carry no mode bits, so if you install those instead, `chmod 755 roer` yourself —
otherwise `M-h` fails at the point where `roer-tmux.conf` invokes the shim.

## Verify the downloads

```sh
shasum -a 256 -c SHA256SUMS.txt
```

## Try it

```sh
roer shell     # a normal terminal
               # press M-h — the terminal lets go and Roer attaches
```
