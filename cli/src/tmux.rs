//! tmux, as the engine underneath. It is an implementation detail: every call
//! is pinned to Roer's private socket and Roer's own config, so the user's own
//! tmux server, sessions and key bindings are never touched.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use crate::Fail;

/// The socket name, overridable so the tests run a server of their own rather
/// than attaching to the sessions of whoever runs them.
pub fn socket() -> String {
    std::env::var("ROER_SOCKET").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "roer".into())
}

pub struct Tmux {
    socket: String,
    conf: PathBuf,
    /// This binary, which the config's M-h binding runs; see `announce`.
    bin: String,
}

impl Tmux {
    pub fn new(conf: PathBuf, bin: String) -> Self {
        Tmux { socket: socket(), conf, bin }
    }

    fn command(&self) -> Command {
        let mut tmux = Command::new("tmux");
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
        self.command().args(args).status().map_err(|e| Fail::new(1, format!("could not run tmux: {e}")))
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
    ///
    /// `announce` rides along as a second command in the same invocation, so
    /// whatever server this starts learns where the M-h binding should point.
    pub fn exec(&self, args: &[&str]) -> String {
        let mut tmux = self.command();
        tmux.args(args).args(self.announce_args());
        replace_with(tmux)
    }

    /// Sets `@roer_bin`, the path the config's M-h binding runs, on a server
    /// already started by `args` in the same invocation.
    ///
    /// Why not "next to the config": a checkout's binary lives in
    /// `cli/target`, its config in `scripts/`, and the binding must reach the
    /// binary that is actually in use rather than whichever one sits beside
    /// the config file.
    pub fn announce_args(&self) -> [&str; 5] {
        [";", "set-option", "-g", "@roer_bin", &self.bin]
    }

    /// `announce` for a server this process did not start by exec.
    pub fn announce(&self) {
        let [_, set, global, key, value] = self.announce_args();
        self.ok(&[set, global, key, value]);
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
fn replace_with(mut command: Command) -> String {
    use std::os::unix::process::CommandExt;
    format!("could not run tmux: {}", command.exec())
}

/// Nothing replaces a process on Windows, and tmux does not run there anyway;
/// this keeps the crate building until a session engine that does exists.
#[cfg(not(unix))]
fn replace_with(mut command: Command) -> String {
    match command.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => format!("could not run tmux: {e}"),
    }
}

/// Whether this process is running inside a pane of Roer's own server, and
/// not merely inside somebody's tmux. A bare `tmux` here goes to whichever
/// server `$TMUX` names, which is exactly the one to ask.
pub fn inside_roer() -> Result<(), Fail> {
    if std::env::var_os("TMUX").is_none_or(|v| v.is_empty()) {
        return Err(Fail::new(2, "not inside a session - start one with `roer` first"));
    }
    let sock = inside_socket().unwrap_or_default();
    let ours = Path::new(&sock).file_name().is_some_and(|name| name == socket().as_str());
    if ours {
        Ok(())
    } else {
        Err(Fail::new(3, format!("inside tmux on {sock}, which is not the roer socket")))
    }
}

/// The socket of the tmux this process is inside, if any.
pub fn inside_socket() -> Option<String> {
    inside(&["display-message", "-p", "#{socket_path}"])
}

/// Asks the tmux this process is inside, via `$TMUX` rather than our socket.
pub fn inside(args: &[&str]) -> Option<String> {
    let out = Command::new("tmux").args(args).stderr(Stdio::null()).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}
