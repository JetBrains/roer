//! tmux, as the engine underneath — or on Windows psmux, a reimplementation of
//! tmux on ConPTY that takes the same commands. It is an implementation
//! detail: every call is pinned to Roer's private socket and Roer's own config,
//! so the user's own server, sessions and key bindings are never touched.
//!
//! What psmux does differently, and so what this file never relies on:
//! chained commands (`a ; b`) are dropped without an error, a *global* user
//! option is invisible to formats, `#{socket_path}` names psmux's default
//! server whatever `-L` says, and `prefix None` is refused.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use crate::Fail;

/// The socket name, overridable so the tests run a server of their own rather
/// than attaching to the sessions of whoever runs them.
pub fn socket() -> String {
    std::env::var("ROER_SOCKET").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "roer".into())
}

/// The engine: tmux, or psmux on Windows, unless `ROER_MUX` names another.
pub fn program() -> String {
    std::env::var("ROER_MUX")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| if cfg!(windows) { "psmux" } else { "tmux" }.into())
}

/// Whether the engine is psmux, which needs the few workarounds below.
fn is_psmux(program: &str) -> bool {
    Path::new(program).file_stem().is_some_and(|stem| stem.eq_ignore_ascii_case("psmux"))
}

pub struct Tmux {
    program: String,
    socket: String,
    conf: PathBuf,
    /// This binary, which the config's M-h binding runs; see `announce`.
    bin: String,
}

impl Tmux {
    pub fn new(conf: PathBuf, bin: String) -> Self {
        Tmux { program: program(), socket: socket(), conf, bin }
    }

    fn command(&self) -> Command {
        let mut tmux = Command::new(&self.program);
        tmux.arg("-L").arg(&self.socket).arg("-f").arg(&self.conf);
        tmux
    }

    /// Runs one tmux command for its exit status, quietly.
    pub fn ok(&self, args: &[&str]) -> bool {
        self.command()
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Runs one tmux command for its output: trimmed of the trailing newline,
    /// and empty when tmux failed, as `$(tm ... 2>/dev/null)` was.
    pub fn read(&self, args: &[&str]) -> String {
        self.command()
            .args(args)
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
            .unwrap_or_default()
    }

    /// Runs one tmux command with its output left on this terminal.
    pub fn run(&self, args: &[&str]) -> Result<ExitStatus, Fail> {
        self.command().args(args).status().map_err(|e| Fail::new(1, format!("could not run {}: {e}", self.program)))
    }

    /// Feeds `input` to a tmux command's stdin: `load-buffer -`.
    pub fn feed(&self, args: &[&str], input: &str) -> bool {
        let Ok(mut child) = self.command().args(args).stdin(Stdio::piped()).spawn() else {
            return false;
        };
        let wrote = child.stdin.take().is_some_and(|mut stdin| stdin.write_all(input.as_bytes()).is_ok());
        wrote && child.wait().is_ok_and(|status| status.success())
    }

    /// Becomes tmux: the attach, with this process gone from between the
    /// terminal and tmux. Returns only if tmux could not be started.
    pub fn exec(&self, args: &[&str]) -> String {
        let mut tmux = self.command();
        tmux.args(args);
        replace_with(tmux, &self.program)
    }

    /// Tells a session where the config's M-h binding should find this binary,
    /// as the `@roer_bin` option. Called whenever roer starts or attaches one.
    ///
    /// Why not "next to the config": a checkout's binary lives in
    /// `cli/target`, its config in `scripts/`, and the binding must reach the
    /// binary actually in use. Per session rather than global, because psmux
    /// formats see only session options — and so a separate command, never
    /// chained onto the attach, since psmux drops chained commands.
    ///
    /// On psmux this is also where the prefix goes out of the way: it refuses
    /// the config's `prefix None`, and a prefix left on C-b would take that key
    /// from every program in the session.
    pub fn announce(&self, target: &str) {
        self.ok(&["set-option", "-t", target, "@roer_bin", &self.bin]);
        if is_psmux(&self.program) {
            self.ok(&["set-option", "-g", "prefix", "M-F12"]);
            self.ok(&["unbind-key", "C-b"]);
        }
    }

    /// `announce` for a session by name.
    pub fn announce_session(&self, session: &str) {
        self.announce(&format!("={session}:"));
    }

    /// Whether this process is running in a pane of Roer's own server, not
    /// merely inside somebody's tmux; the pane it is in, if so.
    pub fn inside_roer(&self) -> Result<String, Fail> {
        if std::env::var_os("TMUX").is_none_or(|v| v.is_empty()) {
            return Err(Fail::new(2, "not inside a session - start one with `roer` first"));
        }
        if is_psmux(&self.program) {
            // No trustworthy socket_path, so ask our own server about the pane
            // this shell says it is in. A pane of some other server is either
            // unknown here or, by chance, a different pane with the same id.
            let pane = std::env::var("TMUX_PANE").unwrap_or_default();
            let known = !pane.is_empty() && self.read(&["display-message", "-p", "-t", &pane, "#{pane_id}"]) == pane;
            return if known {
                Ok(pane)
            } else {
                Err(Fail::new(3, "inside a psmux session that is not on the roer socket"))
            };
        }
        // A bare `tmux` goes to whichever server `$TMUX` names, which is
        // exactly the one to ask.
        let sock = inside(&["display-message", "-p", "#{socket_path}"]).unwrap_or_default();
        let ours = Path::new(&sock).file_name().is_some_and(|name| name == self.socket.as_str());
        if !ours {
            return Err(Fail::new(3, format!("inside tmux on {sock}, which is not the roer socket")));
        }
        Ok(std::env::var("TMUX_PANE")
            .ok()
            .filter(|pane| !pane.is_empty())
            .or_else(|| inside(&["display-message", "-p", "#{pane_id}"]))
            .unwrap_or_default())
    }

    /// The session a pane of this server belongs to.
    pub fn session_of(&self, pane: &str) -> String {
        self.read(&["display-message", "-p", "-t", pane, "#{session_name}"])
    }

    /// Detaches the client this process is running under, from inside it.
    ///
    /// Only tmux can say which client that is. psmux has no current client to
    /// name, and detaching the session's every client instead would throw out
    /// the app that has just taken it over, so there it is left undone: the
    /// app's own `attach -d` has already evicted this terminal.
    pub fn detach_self(&self) -> bool {
        !is_psmux(&self.program) && inside(&["detach-client"]).is_some()
    }

    /// The pane of `session` that a client attaching to it would land on.
    ///
    /// list-panes rather than display-message: as a *pane* target "=name" is
    /// not a session, and tmux answers an unresolvable one with an empty line
    /// and exit 0 rather than an error. The filter picks the active pane of the
    /// active window, so the answer is one id however many there are.
    pub fn active_pane(&self, session: &str) -> String {
        let target = format!("={session}");
        let panes = self.read(&[
            "list-panes",
            "-s",
            "-t",
            &target,
            "-F",
            "#{pane_id}",
            "-f",
            "#{&&:#{pane_active},#{window_active}}",
        ]);
        panes.lines().next().unwrap_or_default().to_string()
    }

    pub fn has_session(&self, name: &str) -> bool {
        self.ok(&["has-session", "-t", &format!("={name}")])
    }
}

#[cfg(unix)]
fn replace_with(mut command: Command, program: &str) -> String {
    use std::os::unix::process::CommandExt;
    format!("could not run {program}: {}", command.exec())
}

/// Nothing replaces a process on Windows: roer waits for the client instead
/// and exits with its code, so the terminal sees the same outcome.
#[cfg(not(unix))]
fn replace_with(mut command: Command, program: &str) -> String {
    match command.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => format!("could not run {program}: {e}"),
    }
}

/// Asks the tmux this process is inside, via `$TMUX` rather than our socket.
fn inside(args: &[&str]) -> Option<String> {
    let out = Command::new("tmux").args(args).stderr(Stdio::null()).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}
