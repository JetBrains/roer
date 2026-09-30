//! tmux, as the engine underneath — or on Windows psmux, a reimplementation of
//! tmux on ConPTY that takes the same commands. It is an implementation
//! detail: every call is pinned to Roer's private socket and Roer's own config,
//! so the user's own server, sessions and key bindings are never touched.
//!
//! What psmux does differently, and so what this file never relies on:
//! chained commands (`a ; b`) are dropped without an error, a *global* user
//! option is invisible to formats, `#{socket_path}` names psmux's default
//! server whatever `-L` says, and `prefix None` is refused.
//!
//! And a pane id is not a pane there. psmux runs a server per session, each
//! numbering its panes from `%1`, and a bare `-t %1` goes to whichever
//! session was active last. So on psmux roer names a pane `=session:.%1`,
//! which psmux resolves exactly, and hands out and takes back that name
//! wherever tmux would use the id: `roer list`, handoff records, M-h, a
//! pane's own answer to where it is.

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
///
/// One beside this binary comes first, so the two can ship as a pair:
/// Roer.app carries its own tmux, and the Windows installer its psmux. Then
/// the version tested is the one that runs, and it is found without `PATH`,
/// which an app started from Finder, and so the server it starts, barely has.
pub fn program(bin: &Path) -> String {
    if let Some(program) = std::env::var("ROER_MUX").ok().filter(|s| !s.is_empty()) {
        return program;
    }
    let name = if cfg!(windows) { "psmux" } else { "tmux" };
    let beside = bin.with_file_name(if cfg!(windows) { "psmux.exe" } else { "tmux" });
    if beside.is_file() {
        return beside.to_string_lossy().into_owned();
    }
    name.into()
}

/// Whether the engine is psmux, which needs the few workarounds below.
fn is_psmux(program: &str) -> bool {
    Path::new(program).file_stem().is_some_and(|stem| stem.eq_ignore_ascii_case("psmux"))
}

pub struct Tmux {
    program: String,
    socket: String,
    conf: PathBuf,
    /// What M-h runs: this binary, handing over the pane; see `announce`.
    handoff: String,
}

impl Tmux {
    pub fn new(conf: PathBuf, bin: String) -> Self {
        let program = program(Path::new(&bin));
        // What M-h runs, in the language of whatever runs it: sh under tmux,
        // PowerShell under psmux. Either way the path is quoted here rather
        // than by `#{q:...}`, whose escaping differs between tmux versions
        // (3.4 turns `$` into `\$`, which sh reads as a backslash and then an
        // expansion), and `#` is doubled so tmux reads none of it as a format.
        let call = if is_psmux(&program) {
            format!("& '{}'", bin.replace('\'', "''"))
        } else {
            sh_word(&bin)
        };
        let pane = if is_psmux(&program) { format!("'{PSMUX_PANE}'") } else { "#{pane_id}".to_string() };
        let handoff = format!("{} handoff --pane {pane}", call.replace('#', "##"));
        Tmux { program, socket: socket(), conf, handoff }
    }

    /// The format that names a pane, as the rest of roer and the app know it:
    /// see the top of this file for why psmux's needs its session.
    pub fn pane_format(&self) -> &'static str {
        if is_psmux(&self.program) { PSMUX_PANE } else { "#{pane_id}" }
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
            .map(|out| lines(&out.stdout))
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

    /// Binds M-h to this binary. Called whenever roer starts or attaches a
    /// session, as a command of its own: psmux drops commands chained onto
    /// another one.
    ///
    /// Why not the config's binding: a checkout's binary lives in
    /// `cli/target`, its config in `scripts/`, and M-h must reach the binary
    /// actually in use rather than whichever one sits beside the config file.
    /// psmux also runs `run-shell` through PowerShell, where the config's
    /// sh-flavoured command is a parse error.
    ///
    /// On psmux this is also where the prefix goes out of the way: it refuses
    /// the config's `prefix None`, and a prefix left on C-b would take that key
    /// from every program in the session.
    pub fn announce(&self) {
        self.ok(&["bind-key", "-n", "M-h", "run-shell", "-b", &self.handoff]);
        if is_psmux(&self.program) {
            self.ok(&["set-option", "-g", "prefix", "M-F12"]);
            self.ok(&["unbind-key", "C-b"]);
        }
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
            // From inside a pane `$TMUX` points psmux at that pane's own
            // session, which is what makes the bare id good enough to ask with.
            let pane = std::env::var("TMUX_PANE").unwrap_or_default();
            let named = if pane.is_empty() { String::new() } else { self.read(&["display-message", "-p", "-t", &pane, PSMUX_PANE]) };
            let known = named.ends_with(&format!(":.{pane}"))
                && self.read(&["display-message", "-p", "-t", &named, "#{pane_id}"]) == pane;
            return if known {
                Ok(named)
            } else {
                Err(Fail::new(3, "inside a psmux session that is not on the roer socket"))
            };
        }
        // A bare `tmux` goes to whichever server `$TMUX` names, which is
        // exactly the one to ask.
        let sock = inside(&self.program, &["display-message", "-p", "#{socket_path}"]).unwrap_or_default();
        let ours = Path::new(&sock).file_name().is_some_and(|name| name == self.socket.as_str());
        if !ours {
            return Err(Fail::new(3, format!("inside tmux on {sock}, which is not the roer socket")));
        }
        Ok(std::env::var("TMUX_PANE")
            .ok()
            .filter(|pane| !pane.is_empty())
            .or_else(|| inside(&self.program, &["display-message", "-p", "#{pane_id}"]))
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
        !is_psmux(&self.program) && inside(&self.program, &["detach-client"]).is_some()
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
            self.pane_format(),
            "-f",
            "#{&&:#{pane_active},#{window_active}}",
        ]);
        panes.lines().next().unwrap_or_default().to_string()
    }

    pub fn has_session(&self, name: &str) -> bool {
        self.ok(&["has-session", "-t", &format!("={name}")])
    }

    /// What `roer diagnose` reports about the engine: which one runs, on which
    /// socket, and how its server sees every client. `client_utf8` is the one
    /// to look at when a terminal shows `_` where text should be: a client
    /// tmux thinks cannot take UTF-8 gets every wide character replaced.
    pub fn describe(&self) -> String {
        let version = Command::new(&self.program)
            .arg("-V")
            .output()
            .ok()
            .map(|out| lines(&out.stdout))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "could not run it".into());
        let mut out = format!("engine: {} ({version})\nsocket: {}\n", self.program, self.socket);
        let server = self.read(&["display-message", "-p", "pid #{pid}, tmux #{version}, config #{config_files}"]);
        if server.is_empty() {
            out.push_str("server: not running\n");
            return out;
        }
        out.push_str(&format!("server: {server}\n"));
        let clients = self.read(&[
            "list-clients",
            "-F",
            "  #{client_tty} session=#{session_name} term=#{client_termname} utf8=#{client_utf8} \
             size=#{client_width}x#{client_height} features=#{client_termfeatures}",
        ]);
        out.push_str(&format!("clients:\n{}\n", if clients.is_empty() { "  none" } else { &clients }));
        out
    }
}

/// Whether a pane's title is only what Windows titles a console with: the
/// path of the program that opened it, `Administrator: ` in front when that
/// runs elevated. psmux reports that for a pane nothing has titled, where tmux
/// would report the hostname.
pub fn is_console_title(title: &str) -> bool {
    let path = title.strip_prefix("Administrator: ").unwrap_or(title);
    let name = path.rsplit(['\\', '/']).next().unwrap_or_default();
    name.len() > ".exe".len() && name.to_ascii_lowercase().ends_with(".exe") && !name.contains(' ')
}

/// A pane as psmux can find it again: in its own session, by id. See the top
/// of this file.
const PSMUX_PANE: &str = "=#{session_name}:.#{pane_id}";

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
/// With `program`, not whatever `tmux` is on `PATH`: Roer.app's tmux is not
/// on it, and a Mac with only the app installed has no other.
fn inside(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| lines(&out.stdout))
}

/// A command's output as lines joined by `\n`, without the last one's end.
/// psmux ends its lines with `\r\n`, and a stray `\r` would make `%1\r` a
/// different pane from `%1` and trail every column `roer list` prints.
fn lines(stdout: &[u8]) -> String {
    String::from_utf8_lossy(stdout).replace("\r\n", "\n").trim_end_matches('\n').to_string()
}

/// `word` as one sh word, whatever is in it: single quotes, inside which sh
/// expands nothing, with any single quote closed, escaped and reopened.
fn sh_word(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::{is_console_title, lines, sh_word};

    #[test]
    fn a_console_left_untitled_has_no_title() {
        assert!(is_console_title(r"C:\Program Files\PowerShell\7\pwsh.exe"));
        assert!(is_console_title(r"Administrator: C:\Program Files\PowerShell\7\pwsh.exe"));
        assert!(is_console_title(r"C:\WINDOWS\system32\cmd.exe"));
        assert!(is_console_title("powershell.EXE"));
        // What an agent sets is kept.
        assert!(!is_console_title("✳ Fix the login bug"));
        assert!(!is_console_title("Fake task"));
        assert!(!is_console_title("Build roer.exe"));
        assert!(!is_console_title(""));
        assert!(!is_console_title(".exe"));
    }

    #[test]
    fn output_lines_lose_crlf() {
        assert_eq!(lines(b"%1\r\n"), "%1");
        assert_eq!(lines(b"a\tb\r\nc\r\n"), "a\tb\nc");
        assert_eq!(lines(b"%1\n"), "%1");
    }

    #[test]
    #[cfg(unix)]
    fn quotes_a_path_as_one_sh_word() {
        assert_eq!(sh_word("/a b/roer"), "'/a b/roer'");
        assert_eq!(sh_word("/it's/roer"), r"'/it'\''s/roer'");
        let odd = "/we ird $HOME `id` \"q\" back\\slash 'x'/roer";
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {}", sh_word(odd)))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), odd);
    }
}
