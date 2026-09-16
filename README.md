# roer

Session host for agent terminals. A session lives in exactly one client at a
time and moves freely between a terminal and the Roer app, so you can start
`claude` in a terminal and finish looking at it in Roer — the process never
restarts.

## Stack

- **Frontend** — React 19 + TypeScript, bundled by Vite
- **Backend** — Tauri 2
- **Terminal rendering** — xterm.js
- **Session engine** — tmux, on a private socket, as a swappable implementation
  detail behind the `roer` CLI

## The two modes

**1. New session.** The launcher lists what is running and offers one button
for one more. Roer runs `roer new` in your home directory, nothing more — `cd`
from there like any shell. `new` rather than `shell` because `shell` reuses a
directory's session on purpose, which would make the second click hand back the
first session.

**2. Teleport an existing session.** Run `roer shell` in a terminal, work in it
(`claude`, `vim`, a dev server — the shell is wrapped, not the agent), then
press `M-h` or invoke the `roer-handoff` skill. The terminal lets go, Roer
attaches, and whatever was running keeps running.

Bare `roer` is mode 1 from the terminal: it opens this directory's session in
the app, creating it if it is not running, and leaves your prompt where it is.
Run inside a session it means mode 2 instead — the session to open is the one
you are in, so it teleports that. Either way, `roer` means "put this session in
front of me in the app", which is why it is the default and `roer shell` is how
you ask for a terminal instead.

### Coming to the front

Opening a session is also a request for the window, so Roer brings itself
forward when a session arrives. On macOS 14 and later that only works one way.
Activation is arbitrated: an app may pull itself in front only if the frontmost
app yields, which IDEs do and terminals do not. The route the system does
honour is `open -a`, run from the terminal you typed in — which is what the
shim does, and why an installed `Roer.app` comes to the front from
Terminal.app.

A `tauri dev` run has no bundle: its binary reports no `CFBundleIdentifier`, so
`open -a Roer` cannot address it and the window stays where it is however
politely it asks. The session still moves — only the window does not follow.
Point `ROER_APP` at a bundle (`ROER_APP=/path/to/Roer.app`) to get the real
behaviour from a checkout, or read the bouncing Dock icon, which is what Roer
falls back to when activation is refused.

The return trip is the same move in reverse: `roer shell` in a terminal takes
the session back, evicting Roer's client. From inside a session, `M-h`
teleports and `M-d` detaches without one. Because exactly one client ever holds a
session, resize never has two masters.

### Why a shim and not an in-app attach

On macOS you cannot take over the PTY of a running process — the emulator that
launched it owns the master fd, and `reptyr`-style ptrace reparenting is
blocked. A session is therefore only teleportable if something detachable owned
its PTY from the start, which is what `roer` provides. A plain `claude` in a
plain Terminal.app tab can never be attached; for that case the skill falls
back to `claude --resume`, which hands over the conversation rather than the
terminal.

## Install the shim

```sh
ln -s "$PWD/scripts/roer" ~/.local/bin/roer   # put this directory on PATH
roer help
```

The script resolves its own path through symlinks, so `scripts/roer-tmux.conf`
in this repo stays the single source of truth for session behaviour. Set
`ROER_BIN` if the app should use a shim from somewhere other than `PATH`,
`ROER_HOME` to move the state directory (default `~/.roer`), and `ROER_APP` to
name the app bundle to bring forward (default `Roer`; see below).

The app looks for the shim in that order: `ROER_BIN`, then `PATH`, then
`~/.local/bin/roer` and `~/bin/roer`. The last two matter for an installed
bundle — an app launched from Finder inherits only
`/usr/bin:/bin:/usr/sbin:/sbin`, so `PATH` alone would not find a shim in your
home directory.

tmux runs on the socket `roer` with `-f scripts/roer-tmux.conf`, so roer
sessions never appear in your own `tmux ls` and your `.tmux.conf` bindings
cannot reach them.

### Session names

A session is named after its directory, as `<basename>-<hash>`, where the hash
is 16 bits of the full path: `roer` in `~/work/api` gives `api-3f5c`. The
basename alone is what you read, and the hash is what keeps two checkouts that
share a name from being the same session — `roer shell` in the other `api`
would otherwise attach to the first one and move it out from under whoever had
it. `roer new` and `roer resume` never reuse a name at all; they count up
(`api-3f5c-2`) so a new session is always a new session.

## Getting out of a session

The prefix key is unbound, so there is no multiplexer UI to escape into. Two
single chords do the whole job, and neither needs a shell prompt — which
matters, because you do not have one while `claude`, an editor or a dev server
owns the foreground:

| Key | Action |
| --- | --- |
| `M-d` | detach: the session keeps running with no client |
| `M-h` | hand off: Roer attaches, the terminal lets go |

`M-` is Meta, i.e. Alt — Option on a Mac, and macOS does not send it by
default. Either turn it on (iTerm2: *Profiles → Keys → Left Option key: Esc+*;
Terminal.app: *Settings → Profiles → Keyboard → Use Option as Meta key*) or
press `Esc` then the letter, which tmux reads as the same key. Note that `M-d`
is `kill-word` in emacs-mode readline, and tmux takes the key first, so you
lose Option+d inside a roer session.

Three more ways, for when you are not in the session at all:

- `roer detach` at a prompt inside it, or `roer detach <name>` from any other
  terminal
- `roer shell` / `roer attach <name>` in a terminal — attaching evicts whoever
  held the session, which is the whole return trip. Note that bare `roer` does
  the opposite: it sends the session *to* the app.
- **clicking the session in Roer's sidebar**, which does the same thing from
  the app side: nothing has to be typed into the terminal that is stuck

| Command | Action |
| --- | --- |
| `roer` / `roer app [name]` | open this directory's session in the Roer app, creating it detached if needed; inside a session, teleport that session |
| `roer shell [name]` | create or reattach this directory's session **in this terminal**, detaching any other client |
| `roer attach [name]` | take a session back; with no name, lists sessions |
| `roer list` | sessions as TSV: session, pane, attached/detached, cwd, command |
| `roer detach [name]` | release the session; it keeps running with no client |
| `roer resume <id>` | resume a Claude conversation inside a new session, in manual permission mode |
| `roer handoff` | teleport this session into Roer (used by the skill) |
| `roer handoff --pane <id>` | the same, for the `M-h` binding: `run-shell` has no session environment to read the pane or its directory from |

## Prerequisites

- Node.js 22.13+ or 24+ (Vitest 5 and jsdom both require it)
- Rust toolchain (for the Tauri backend): https://rustup.rs
- Tauri's platform dependencies: https://tauri.app/start/prerequisites/
- tmux 3.3+ (for `allow-passthrough`)

## Development

```sh
npm install
npm run tauri dev   # desktop app (requires Rust)
npm run dev         # frontend only, http://localhost:1420
npm run assemble    # debug Roer.app, for testing a handoff by hand
```

`assemble` is what makes a handoff testable the way a user meets it. `tauri
dev` builds a bare executable that LaunchServices cannot address, so the shim's
`open -a Roer` neither starts it nor brings it forward; the app bundle it
writes to `src-tauri/target/debug/bundle/macos/Roer.app` has an identifier and
an icon, so the whole path works — including activation from a terminal and the
Dock icon a refused activation falls back to.

Stop a `tauri dev` run first. Both builds share the identifier
`com.jetbrains.roer`, and `tauri-plugin-single-instance` makes whichever starts
second exit at once — so a stale bundle can quietly answer handoffs while you
watch a dev instance that is no longer running. The IntelliJ run configurations
in `.idea/runConfigurations/` cover this: **Assemble Roer.app** stops any
running instance, builds the bundle and opens it.

Handoffs are delivered through a watched directory (`~/.roer/handoffs/`) rather
than a `roer://` deep link, because macOS registers custom URL schemes for
installed `.app` bundles only — deep links would be dead under `tauri dev`.

A handoff must not half-happen: the terminal has to know whether it still holds
the session, and it cannot ask for it back once it has let go. So a record
moves through three states, each reached by one atomic rename or unlink:

| `<ts>.json` | written by the shim; nobody has it yet |
| `<ts>.json.claimed` | Roer has taken it and is attaching |
| gone | Roer has it on screen — the terminal may let go |
| `<ts>.json.failed` | Roer could not open it; nothing moved |

The claim is what makes a timeout safe. The shim gives up by renaming the same
path it is waiting on, so if it got there first the claim fails and Roer drops
the handoff instead of attaching to a session whose terminal has just been told
it kept it. Exactly one side wins each rename. The record is deleted only once
a terminal is really rendering the session in the app, and Roer waits for
output to prove it — an attach that fails prints an error and exits, which
would otherwise read as success.

## Local changes

The stage has two tabs. **Changes** shows what the session's own repository
has uncommitted: the folder tree on the left, the selected file's diff on the
right.

| Key | Action |
| --- | --- |
| `↑` / `↓` | previous / next change, crossing into the next file at the edges |
| `←` / `→` | previous / next file |
| click a folder | collapse it; the arrow keys still walk the changes inside |

The diff pane is dressed as an IntelliJ diff: JetBrains' New UI dark editor
colours, gutters and Darcula token palette, a sticky head saying what happened to the file, and code that
is syntax-coloured rather than flat. `lib/highlight.ts` does the colouring
with regex token classing, not a parser per language: one diff can touch Rust,
TypeScript, shell and JSON, and being wrong on a token now and then is worth
not carrying a grammar for each. Text is set in JetBrains Mono when it is
installed, and falls back to the platform's mono otherwise.

Either layout wears it: **Side by side** is the IDE's reading — old file left,
new one right, with the edited run inside a changed line picked out — and
**Unified** is the terminal's, one column of `+` and `-` lines. The arrow keys
and the current-change highlight work the same in both.

Which repository is a question about the *session*, not about Roer: it is
whatever holds the pane's current directory, re-read every time the tab comes
to the front, so a `cd` in the terminal moves the view with it.

Four things are deliberate:

- **The terminal stays mounted underneath.** The changes view is an overlay.
  Unmounting the terminal would close its PTY, which ends Roer's tmux client
  and releases the session — switching tabs would hand your session away.
- **Staged and unstaged are kept apart**, because `git commit` treats them
  differently. Porcelain v2 is the only status format that reports both sides,
  which is why the backend parses that and not `--porcelain=v1`. It reads it
  NUL-delimited: a path may hold anything but NUL, and the line form escapes
  such a name into a spelling that cannot be diffed.
- **A side-by-side row is a pair, not two lines.** Removals and additions
  arrive from `git diff` as two runs; pairing them in order is what puts an
  edit beside the line it replaced, and a row with only one side is a gap
  rather than a blank line.
- **The unit of navigation is the hunk**, not the file or the line. Pressing
  down should land on the next thing that actually changed.

Line counts come from two bulk calls — `status --porcelain=v2` and one
`diff --numstat HEAD` — rather than a `git` process per row; a repository
mid-refactor has hundreds of rows. Untracked files are in no diff at all, so
their lines are counted from disk, and diffed against `/dev/null`.

## Checks

```sh
npm test            # Vitest
npm run build       # tsc --noEmit + vite build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Layout

```
scripts/roer              CLI shim: the session contract
scripts/roer-tmux.conf    invisible substrate (no status bar, no prefix, RGB, passthrough)
src/
  App.tsx                 sidebar plus stage, tabs, handoff listener
  SessionList.tsx         the sessions sidebar and the new-session button
  TerminalView.tsx        xterm.js host wired to a PTY
  ChangesView.tsx         folder tree plus diff for the session's repository
  lib/pty.ts              typed bridge to the Rust PTY and handoff commands
  lib/git.ts              typed bridge to the Rust git commands
  lib/diff.ts             unified diff -> hunks, and hunks -> side-by-side rows
  lib/highlight.ts        code -> coloured spans, marking the edited run
  lib/tree.ts             changed paths -> compacted folder tree
src-tauri/src/
  pty.rs                  one PTY per view, output over a Tauri Channel
  handoff.rs              watches ~/.roer/handoffs/, claim/ack/fail on the record
  git.rs                  status and diff for the session's repository
  roer.rs                 the only place that invokes the shim
.claude/skills/roer-handoff/
```

> `src-tauri/icons/` holds the app icon. `tauri::generate_context!()` reads `icon.png`
> at build time, so the directory cannot be emptied — even `npm run tauri
> dev` fails without it. Regenerate with `npm run tauri icon <source.png>`;
> the icon is embedded at compile time, so touch a file under
> `src-tauri/src/` afterwards or cargo will reuse the stale binary.
