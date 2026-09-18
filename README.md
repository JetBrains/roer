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

## Install

Download `Roer_<version>_universal.dmg` and `roer-cli-<version>.tar.gz` from
[Releases](https://github.com/JetBrains/roer/releases). One universal build
covers Apple silicon and Intel; macOS 14 or later.

Three steps, all of which the release notes spell out: drag Roer to
Applications and clear its quarantine flag (`xattr -dr
com.apple.quarantine /Applications/Roer.app`), `brew install tmux`, then unpack
the shim tarball into one directory and symlink `roer` onto your `PATH`.

The quarantine step is required, not optional — the app is killed on first
launch without it. Roer is not notarized yet, so signing does not remove it;
each release's notes say whether that build was signed.

Take the tarball rather than the two loose assets: release assets carry no mode
bits, and `roer` must be executable for `M-h` to work at all.

### Install the shim from a checkout

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

### Session history

Roer holds no session state of its own by design: tmux is the persistence
layer, and the app can restart without losing anything. Past-session history
is a deliberate, narrow exception to that, not a reversal of it. Every
session gets a durable id — a tmux user option (`@roer_id`) stamped by the
shim, since a pane id is recycled the moment a session ends and a name is
freed for reuse at the same instant, so neither survives long enough to key
history. `~/.roer/sessions.json` records only `{id, name, cwd, createdAt,
updatedAt, endedAt}` for sessions that have ended — never a pane, attach
state, command line, or anything typed into or printed by the session. Every
*live* fact still comes fresh from `tmux`/`roer list` on every read, never
from that file, so deleting it costs only its own bookkeeping (the set of
directories the "Resume" list below scans), never a running session.

The sidebar's "Resume" list itself shows past **Claude Code conversations**,
not raw tmux history: it reads Claude's own transcripts under
`~/.claude/projects/<encoded cwd>/` (bounded head/tail reads, never a whole
transcript) for every directory roer already knows about — live sessions'
directories plus the ones in `sessions.json` above — and never scans any
other project on the machine. It also checks Claude's own
`~/.claude/sessions/<pid>.json` registry so a conversation a live `claude`
process still holds elsewhere isn't offered twice; this check is best-effort
(no pid-reuse tolerance), so the worst case is `claude --resume` itself
refusing, not a wrong resume. Roer only ever reads under `~/.claude`, never
writes there. Clicking a row runs `roer resume <id>`, which is nothing
special until you click it — no conversation resumes on its own.

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
| `roer list` | sessions as TSV: id, session, pane, attached/detached, cwd, command |
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

The stage opens on the terminal, with **Changes** beside it and a tab per file
you open. **Changes** shows what the session's own repository has uncommitted:
the folder tree on the left, the selected file's diff on the right.

| Key | Action |
| --- | --- |
| `↑` / `↓` | previous / next change, crossing into the next file at the edges |
| `←` / `→` | previous / next file |
| click a folder | collapse it; the arrow keys still walk the changes inside |

The diff pane is dressed as an IntelliJ diff: JetBrains' New UI dark editor
colours, gutters and Darcula token palette, a sticky head saying what happened to the file, and code that
is syntax-coloured rather than flat. `lib/highlight.ts` does the colouring
with a TextMate grammar per language, the same machinery an editor uses, which
is the only way to know that `#` opens a comment in Python and an attribute in
Rust. Fifteen grammars are carried, one lazily loaded chunk each, and
`lib/lang.ts` picks one off the file's extension; a file it has no grammar for
falls back to regex token classing, which is wrong on a token now and then and
better than flat. Text is set in JetBrains Mono when it is installed, and falls
back to the platform's mono otherwise.

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

## Go to File

`Cmd+Shift+O` — IntelliJ's shortcut — opens a fuzzy search over every file in
the session's repository, and the file you pick opens in a tab of its own,
read only.

| Key | Action |
| --- | --- |
| `Cmd+Shift+O` | open the search |
| `↑` / `↓` | previous / next match, wrapping at both ends |
| `Enter` | open the selected file in a tab |
| `Escape` | close, and give the keyboard back |
| `App.tsx:42` | open that file scrolled to line 42 |

The shortcut works while you are typing in the terminal, which is the whole
reason the listener is registered on `window` in the **capture phase**:
xterm.js listens on its own textarea deep inside the stage, and capture runs
on the way down, before any listener on a descendant. The handler stops the
event there, so the `O` never reaches the PTY. `Cmd+W` is deliberately *not*
bound — the app defines no menu of its own, so Tauri's default macOS menu owns
it as Close Window and handles its key equivalent before the webview sees it.
Tabs close with their `×`.

Typing nothing lists the files already open, most recently used first.

**The selection is a path, not a row number.** A stale snapshot answers
straight away and rebuilds behind you, and the popup keeps asking the same
query until that build lands, so the list can come back longer, shorter or in
a different order while your finger is still on `↓`. Holding a row number
would move the selection to another file each time; holding the path moves the
highlight with the file. For the same reason hovering only claims the
selection when the pointer has really moved — scrolling the list with the
arrow keys slides a row under a resting mouse, and the browser reports a move
that no hand made.

### Why the index and the matcher are both in Rust

It is important to scale up to half a million paths. Handing that list to the
renderer costs more than the search does — once, let alone per keystroke — so
`files.rs` holds the paths and does the matching, and what crosses the IPC
bridge is a query and fifty answers with the matched character positions, a
few kilobytes.

The list is `git ls-files -z --cached --others --exclude-standard`: what git
tracks plus what you have just written, with `.gitignore` respected. A file
created a minute ago is findable and `node_modules` is not in the list at all.
NUL-delimited for the reason the status parser is: a path may hold anything but
NUL, and the line form escapes such a name into a spelling that cannot be
opened.

One snapshot per worktree, keyed by root, because a session can `cd` into
another repository. Every path lives in one contiguous `String` with a `Vec` of
offsets over it rather than in a `Vec<String>` — half a million paths is about
thirty megabytes of text, and spelling that as half a million separate
allocations costs more in headers and allocator churn than the text itself.

**That `String` is the listing itself.** `git ls-files -z` already hands over
every path in one allocation, in exactly the shape the index wants, so the
listing is kept and spanned in place: the text is never moved and the *spans*
are sorted, comparing the slices they point at. Copying it out instead meant
holding two buffers of the same size plus a `Vec<&str>` of fat pointers, which
on a big repo of 1.36M files measured like this:

| | listing copied out | spanned in place |
| --- | --- | --- |
| Peak while building | 349 MB | **149 MB** |
| The index it produces | 137.4 MB | 138.7 MB |

The index is the same size either way — the extra 1.3 MB is the NUL after each
path, kept rather than compacted out. What goes away is the peak, which was
2.5× the thing being built. `git.rs` earns part of that: `from_utf8_lossy`
hands back a *borrowed* `Cow` for valid UTF-8, so `into_owned` copied all 123 MB
of stdout a second time, where `String::from_utf8` converts in place and falls
back to lossy only for output that really is invalid.
The snapshot is held behind an `Arc`, so a query clones a pointer, drops the
lock and matches without holding anything; a rebuild swaps a new `Arc` in and
never blocks a reader.

**Nothing waits for git.** A search against a root nobody has asked about yet
answers `indexing` with no hits and starts the build behind it, so the popup
opens now and fills in when the listing lands. A stale snapshot is served
anyway and a rebuild starts behind it. A set of roots with a build in flight
collapses a burst of keystrokes into one `git ls-files`.

**How long a snapshot is trusted is measured, not fixed.** Five seconds is the
floor; past that a snapshot is trusted for ten times whatever its own build
cost. `git ls-files` over a big repo of 1.36M paths takes twenty seconds, so a
fixed five-second window guaranteed that every snapshot was already fifteen
seconds stale the moment it arrived — every keystroke started another
twenty-second build, forever, and the repository was never anything but
indexing. Scaling the window by the cost stops that: a cheap repository stays
within a second or two of the truth, and an expensive one is re-listed at a
rate it can actually sustain. The cost is recorded whether the build succeeded
or failed, because a listing that takes twenty seconds to fail should not be
retried on the next keystroke either. A **watched** root is kept current by
patches instead, so its clock is only a backstop and the multiplier is sixty
on a five-minute floor.

**The poll behind a build backs off.** While `indexing` is true the popup asks
the same query again, starting at 150 ms and growing by 1.6× to a ceiling of
two seconds — fourteen round trips across a twenty-second build instead of a
hundred and thirty-three. Typing resets it, because a new query deserves a prompt
answer again. What re-arms the next ask is having made one, never the answer
object: an answer identical to the last would not re-run an effect watching it,
and over the IPC bridge every answer is a fresh object anyway, which is exactly
why identity would be a poor thing to depend on.

Matching is three phases, so the expensive part only ever sees a handful of
candidates: a byte-level case-folded subsequence test rejects almost
everything; the survivors are scored — an exact file name first, then a prefix
of it, a match inside the name over one in the directories, contiguous runs
super-linearly, and a character landing on a word start (a path segment, or
after `_`, `-`, `.`, or a camelCase hump) like the start of a word, which is
what makes `gtf` find `GoToFile.tsx`; and only the winners get their match
positions worked out. A query under three characters is held to a word start,
or a repository this size would answer with all of it. Positions come back as
**byte** offsets, which is what slicing a string takes on both sides of the
bridge.

The scan is spread over the machine's cores with `std::thread::scope`, each
thread keeping its own best fifty. That is not premature: the prefilter has to
read every path, and one core cannot keep a keystroke inside a frame at this
size. On a synthetic big repo of 500k paths, a release build answers a query
that matches nothing in 1.6 ms and one that matches *every* path in 8.6 ms —
against 14 ms and 65 ms on one thread. `cargo test --release --lib -- --ignored
--nocapture searches_a_big_repo` is that measurement. Merging per-thread
winners reaches the answer one thread would have, because ranking a path never
depends on another path, and ties break on the path's own position in the
index; a test asserts the two agree.

A watched repository is **patched**, not re-listed: see
[Watching the worktree](#watching-the-worktree).

### The file tab

Read only, numbered, coloured by the same grammars the diff uses, and
**windowed**: only the visible lines are in the DOM, with a spacer above and
below so the scrollbar still measures the whole file. Rows are uniform height,
measured once from a real row rather than hardcoded.

Three caps, each for a different reason:

- **The read stops at 1 MB**, and the view says so. The viewer is for reading
  code; a generated bundle is not that.
- **Colouring stops at 5 000 lines**, separately from the windowing, because
  tokenising is not a drawing cost — hiding lines does not make
  `codeToTokens` cheaper. Past it the view falls back to the regex painter,
  which is per line, and says the file is too long to colour fully.
- **Eight file tabs**, evicting the least recently used — IntelliJ's rule, at
  the width the strip has. The strip keeps the order files were opened in and
  eviction goes by the order they were last used; folding those two together
  would shuffle the strip under the pointer on every switch.

A tab stays *mounted* while another is on top, hidden rather than unmounted,
so its scroll position and colouring survive a trip to the terminal — the same
reason the changes view is an overlay. It re-reads its file whenever it comes
back to the front, because the session behind it has been editing files the
whole time it was hidden; the text on screen is kept until the new read lands,
so a refresh does not blink and does not lose your place. A path is resolved
against the worktree root and refused if it escapes it, so a crafted `../`
cannot read outside the repository.

## Watching the worktree

Every view of a repository used to learn about a change by being *looked at*:
the diff view reloaded when its tab came to the front, a file tab re-read on
activation, and the index was re-listed on a timer. An agent edits files the
whole time you are watching it, so "when you look at it" is the wrong moment —
you sit on the diff while it works and nothing moves.

macOS can simply say. `watch.rs` arms one recursive FSEvents watch per
worktree through `notify` — the same crate `handoff.rs` uses — and one thread
reads it. Arming is kernel-side rather than a walk of the tree: **4.9 ms** on
a worktree of 1.36M files, so watching costs nothing even where listing costs
twenty seconds.

Nothing in the frontend arms anything. A watch is started by whichever command
resolves a root — `git_changes`, `file_read`, `files_search` — so opening the
diff view is what asks for live diffs and never opening it asks for nothing.
Eight roots are held at once, the least recently asked about evicted, which
bounds a session that `cd`s around.

**A batch is classified by directory, never by file.** Twenty thousand files
written into an ignored build directory arrived as 66,032 events naming 20,002
distinct paths and exactly *one* distinct parent directory. Reducing each path
to its directory is what turns that firehose into a single question for git —
answered "ignored" — after which the whole burst reaches neither git nor the
UI. A path at the top of the worktree stands for itself, because its directory
is the whole repository and that is the one pathspec that is never cheap.

Each batch closes after 300 ms of quiet, or 2 s after its first event so a
continuous build still gets answered, and then:

1. **Drop what nothing can matter in.** Unknown directories go out in one
   `git check-ignore -z --stdin`; the answer is cached per root, and a
   directory under a cached dead one is dropped without asking. Ignored is
   not quite the test, though — a directory can be ignored and still hold
   *tracked* files, whose edits show in `git status` and in the diff like any
   other, so each ignored directory is also asked once whether
   `ls-files --cached` finds anything in it. The verdict is cached with the
   ignore answer, so the twenty-thousand-file build pays for that question
   once. An event naming a `.gitignore` empties the cache — and takes the
   whole listing, because a rule decides which *existing* files are listed
   and none of those files move when it changes, so nothing scoped can see
   it and neither can `git status`.
2. **Fit the listing.** Git's cost here grows with the *number* of pathspecs,
   not with what they cover — on a big repo one directory measured at 0.21 s,
   sixteen at 0.31 s and three hundred at 2.32 s. So past twenty-four the
   deepest directories give up their last component, all at that depth in one
   sweep, until few enough are left. Reaching the top of the worktree is where
   it stops and the snapshot is retired instead.
3. **Patch the index.** One `git ls-files -z --cached --others
   --exclude-standard -- <dirs>` and `files::patch`.
4. **Tell the frontend**, `roer://files-changed` with the paths and a `broad`
   flag for a batch that gave up naming them.

A batch that survives with nothing in it — the common case under an ignored
build — skips all four.

`.git` is skipped entirely. Staging, committing and `gc` churn it violently
and none of them change either answer: `--cached --others` covers staged and
unstaged alike, and `git status` is re-asked from the worktree events anyway.

**Patching produces a new index, never edits one.** The `Arc` snapshot is read
without a lock, so `files::patch` builds a replacement and swaps it in exactly
as a rebuild does. Because the spans are sorted by path text, everything under
`dir/` is one contiguous range found with two `partition_point` calls — and the
directory's *own* entry is a second, separate range. That separation is
load-bearing: `-` is 0x2D and `.` is 0x2E, both below `/` at 0x2F, so `src`
and `src/App.tsx` are not neighbours — `src-old` and `src.bak` sit between
them — and one range spanning both would quietly eat them. The merge walks the
surviving spans once against the sorted fresh listing into a buffer sized
exactly for the job, and runs with the lock released: the old `Arc` goes on
answering queries for the tens of milliseconds it takes. The next lever, if
that copy ever matters, is keeping the base buffer and scanning added text as
a second chunk.

Pathspecs go out as `:(literal)…`. A bare pathspec is a glob, so a directory
really named `a[1]` would be read as a character class and match nothing — and
the patch would then delete it. `check-ignore` needs its own helper for two
reasons: it exits **1** to say "none of these are ignored", which is an answer
rather than a failure, and it wants a real pipe on stdin, which
`Command::output` nulls. The write goes on a thread of its own, because git
answers while the question is still being asked and a batch past the 64 KB
pipe buffer would otherwise deadlock.

**The timer is kept as a backstop.** FSEvents can drop events under load, and
the collapse in step 2 gives up on purpose. Both are *silent* — the index would
just quietly lack a file for the rest of the session, which on an experimental
feature is the failure you would not think to blame. A twenty-second listing every twenty minutes on a
background thread is a cheap price for every such hole closing by itself.
`Index.built` is therefore carried forward by a patch rather than reset, or a
steadily-patched repository would hold the backstop off forever. Anything that
*announces* itself — a rescan flag, an escalation, a watcher error — retires the
snapshot at once instead of waiting for the window.

The two views that should feel live take one listener, in `App.tsx` beside the
handoff listener, fanned out through `onFilesChanged`. The event object itself
is held in state, so each batch is a new identity and a view can tell the one
it has already acted on. The diff view bumps the token its load effect already
watches, behind an in-flight guard — `git status` on a big repo is 1.73 s, and
a batch every 300 ms would otherwise stack reloads faster than they finish, so
a change during a load sets a pending flag and exactly one more reload follows.
A file tab re-reads when the event names *its* path, or when `broad` is set;
only while it is active, since a hidden tab already re-reads on the way in.
Both keep the old text on screen until the new read lands, so nothing blinks.

The Go to File popup is deliberately left alone. It re-asks on every keystroke,
so a fresh index is all it needs, and a list reordering itself under your
fingers is the bug that was just fixed.

## Off the main thread

Tauri runs a plain `#[tauri::command]` **on the main thread**, so anything slow
in one freezes the window for as long as it takes. Every command that shells
out is therefore `#[tauri::command(async)]`, which runs the same synchronous
body on the async runtime instead:

| Command | What it waits for |
| --- | --- |
| `files_search` | a `git rev-parse`, then a scan of the whole index — 35 ms per keystroke on a big repo of 1.36M paths |
| `file_read` | canonicalising two paths and up to a megabyte off a cold disk |
| `git_changes` | `git status` over the worktree — 1.7 s on that same big repo |
| `git_diff` | two more git invocations |
| `roer_status`, `roer_sessions` | spawning the shim; `roer_sessions` is asked on the way into every Go to File, to find out which repository the session is in |

The PTY commands stay synchronous deliberately. They are already cheap — a
write hands bytes to a file descriptor — and an async command runs on a thread
pool, which would put the ordering of your keystrokes at the mercy of the
scheduler.

## Checks

```sh
sh scripts/check-version   # the five version records agree
npm test                   # Vitest
npm run build              # tsc --noEmit + vite build
cargo test --manifest-path src-tauri/Cargo.toml
sh -n scripts/roer         # the shim has no compiler behind it
```

**The order is load-bearing, not stylistic.** `npm run build` must precede
`cargo test`: `dist/` is gitignored and `tauri::generate_context!()` embeds
`frontendDist` (`../dist`) at compile time, so on a clean checkout the Rust
build fails with *"The `frontendDist` configuration is set to `../dist` but this
path doesn't exist"*. `.github/workflows/ci.yml` runs exactly this list, in
exactly this order.

The workflows are linted separately, in their own CI job:

```sh
brew install actionlint shellcheck   # actionlint runs shellcheck when it finds it
actionlint .github/workflows/*.yml
```

`.github/actionlint.yaml` declares `sre-eqx-kata`, the self-hosted signing
runner, so the one label actionlint cannot resolve does not drown the real
findings. Pin the same version CI pins (`ACTIONLINT_VERSION` in `ci.yml`) if you
want local and CI results to agree.

## Cutting a release

Versions live in five places — `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
`src-tauri/tauri.conf.json`, `package.json` and `package-lock.json`. Bump all
of them, then:

```sh
sh scripts/check-version           # they agree with each other
sh scripts/check-version v0.2.0    # ...and with the tag you are about to push
sh scripts/check-version --print   # just print it
```

`check-version` fails if a regex matches nothing, so a refactor that moves a
version field breaks the release loudly rather than passing silently.

Merge to `main`, then push the tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` refuses a tag that is not an ancestor of `main`
or that disagrees with those five records, builds the universal bundle, sends
the `.app` to the JetBrains CodeSign service, images the `.dmg` with `hdiutil`,
and opens a **draft prerelease**. Publishing it is a manual step, on purpose:
confirm the app opens from `/Applications` and that `M-h` hands a session over
first. A correct `.dmg` with a non-executable shim passes `roer help` and fails
exactly at `M-h`, because `roer-tmux.conf` invokes the shim as an executable.

Signing is gated on a `CODESIGN_ENABLED` repo variable. With it unset the
`codesign` job is skipped and the pipeline produces an unsigned `.dmg`, so
releases work before the service account is issued.

To build a release bundle locally:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run release:local
lipo -archs src-tauri/target/universal-apple-darwin/release/bundle/macos/Roer.app/Contents/MacOS/roer
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
  GoToFile.tsx            the Cmd+Shift+O search over the repository's files
  FileView.tsx            read-only windowed viewer behind a file tab
  CodeLine.tsx            coloured spans -> DOM, shared by the diff and viewer
  lib/pty.ts              typed bridge to the Rust PTY and handoff commands
  lib/git.ts              typed bridge to the Rust git commands
  lib/files.ts            typed bridge to the file index and the file reader
  lib/tabs.ts             what the stage shows: open, close, activate, evict
  lib/keys.ts             capture-phase shortcuts, so the terminal cannot eat them
  lib/session.ts          which directory the session is in, pane first
  lib/diff.ts             unified diff -> hunks, and hunks -> side-by-side rows
  lib/highlight.ts        code -> coloured spans, marking the edited run
  lib/lang.ts             extension -> grammar, and the lazy loader for each
  lib/theme-darcula.ts    the Darcula palette as TextMate scope rules
  lib/tree.ts             changed paths -> compacted folder tree
src-tauri/src/
  pty.rs                  one PTY per view, output over a Tauri Channel
  handoff.rs              watches ~/.roer/handoffs/, claim/ack/fail on the record
  watch.rs                one FSEvents watch per worktree, batched by directory
  history.rs              ~/.roer/sessions.json: past-session metadata only
  claude.rs               reads ~/.claude/* for resumable past conversations
  git.rs                  status and diff for the session's repository
  files.rs                the flat file list, the fuzzy matcher, the file reader
  roer.rs                 the only place that invokes the shim
  testing.rs              scratch repositories for the Rust tests
.claude/skills/roer-handoff/
```

> `src-tauri/icons/` holds the app icon. `tauri::generate_context!()` reads `icon.png`
> at build time, so the directory cannot be emptied — even `npm run tauri
> dev` fails without it. Regenerate with `npm run tauri icon <source.png>`;
> the icon is embedded at compile time, so touch a file under
> `src-tauri/src/` afterwards or cargo will reuse the stale binary.
