//! The `roer` shim is the only thing Roer talks to.
//!
//! Sessions are never created or attached by invoking tmux directly: the shim
//! owns the socket name, the config and the attach semantics, so the engine
//! stays swappable without touching Rust.

use std::path::PathBuf;

use serde::Serialize;

use crate::history::{self, PastSession};

/// Where the shim is looked for, relative to `$HOME`. A window opened from
/// Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, so an
/// installed app cannot rely on `PATH` the way a `tauri dev` run can — and the
/// handoff depends on it, because the shim itself runs `open -a Roer`.
const INSTALL_PATHS: [&str; 2] = [".local/bin/roer", "bin/roer"];

/// Path to the shim: `ROER_BIN` first, so a checkout can point at its own
/// copy, then `PATH`, then the usual install locations under `$HOME`.
pub fn bin() -> String {
    resolve(std::env::var("ROER_BIN").ok(), on_path("roer"), home())
}

fn resolve(explicit: Option<String>, on_path: bool, home: Option<PathBuf>) -> String {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return explicit;
    }
    if on_path {
        return "roer".to_string();
    }
    home.map(|home| INSTALL_PATHS.iter().map(move |rel| home.join(rel)))
        .and_then(|mut candidates| candidates.find(|path| path.is_file()))
        .map(|path| path.to_string_lossy().into_owned())
        // Nothing found: report the plain name, so the error names what was
        // missing rather than a path the user never chose.
        .unwrap_or_else(|| "roer".to_string())
}

/// The person's home directory: `$HOME` on Unix, the profile directory
/// (`USERPROFILE`) on Windows, which has no `HOME` of its own.
pub fn home() -> Option<PathBuf> {
    // Deprecated for a Windows quirk fixed in Rust 1.85, and since undeprecated.
    #[allow(deprecated)]
    let home = std::env::home_dir();
    home.filter(|h| !h.as_os_str().is_empty())
}

/// Whether a bare name resolves through `PATH`, without running it.
pub(crate) fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let pathext = if cfg!(windows) {
        Some(std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string()))
    } else {
        None
    };
    let names = file_names(name, pathext.as_deref());
    std::env::split_paths(&path).any(|dir| {
        names.iter().any(|file| {
            let candidate = dir.join(file);
            candidate.is_file() && is_executable(&candidate)
        })
    })
}

/// The file names a program called `name` may have on disk. Windows finds
/// one by extension — `gh` is `gh.exe` — trying each `PATHEXT` lists in turn.
fn file_names(name: &str, pathext: Option<&str>) -> Vec<String> {
    let mut names = vec![name.to_string()];
    if let Some(pathext) = pathext {
        names.extend(pathext.split(';').filter(|ext| !ext.is_empty()).map(|ext| format!("{name}{ext}")));
    }
    names
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub session: String,
    pub pane: String,
    pub attached: bool,
    pub cwd: String,
    pub command: String,
    /// What the program in the pane last titled it — Claude Code's summary of
    /// the task. Empty when nothing has, or when the shim predates the column.
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub bin: String,
    pub available: bool,
    /// Default directory for a new session, so the launcher has something
    /// sensible to show without a filesystem-dialog plugin.
    pub home: String,
}

/// Whether the shim can be found, so the UI can explain how to install it
/// instead of failing at spawn time with a bare ENOENT.
///
/// `async` because both of these spawn a process, and Tauri runs a plain
/// synchronous command on the main thread. `roer_sessions` in particular is
/// asked on the way into every Go to File — resolving which repository the
/// session is in starts there — so a stall here is a stall before the popup.
#[tauri::command(async)]
pub fn roer_status() -> Status {
    let bin = bin();
    let available = crate::process::command(&bin)
        .arg("help")
        .output()
        .is_ok();
    Status {
        bin,
        available,
        home: home()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Submits `text` as a prompt to whatever runs in `pane` — how the Pull
/// Request tab hands the session's agent a request. The shim does the
/// typing, since only it knows the engine underneath.
#[tauri::command(async)]
pub fn roer_send(pane: String, text: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = crate::process::command(bin())
        .args(["send", "--pane", &pane])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run `{} send`: {e}", bin()))?;
    child
        .stdin
        .take()
        .expect("stdin is a pipe")
        .write_all(text.as_bytes())
        .map_err(|e| format!("could not write to `roer send`: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not wait for `roer send`: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Existing sessions, for the launcher's attach list.
///
/// `async` for the reason [`roer_status`] is.
#[tauri::command(async)]
pub fn roer_sessions() -> Result<Vec<SessionInfo>, String> {
    Ok(live_sessions()?)
}

/// Sessions that used to be live and no longer are, most recently ended
/// first. Reconciling history is a side effect of this call, so it is only
/// meaningful read alongside (or just after) [`roer_sessions`].
#[tauri::command]
pub fn roer_past_sessions() -> Result<Vec<PastSession>, String> {
    let live = live_sessions()?;
    Ok(history::reconcile(&live))
}

fn live_sessions() -> Result<Vec<SessionInfo>, String> {
    let out = crate::process::command(bin())
        .arg("list")
        .output()
        .map_err(|e| format!("could not run `{} list`: {e}", bin()))?;

    // `roer list` is intentionally quiet when no server is running, so empty
    // output means "no sessions", not an error.
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_line)
        .collect())
}

/// One TSV row: id, session, pane, attached|detached, cwd, command, title.
fn parse_line(line: &str) -> Option<SessionInfo> {
    // The title is free text and comes last, so it keeps any tab it contains.
    let mut f = line.splitn(7, '\t');
    let info = SessionInfo {
        id: f.next()?.to_string(),
        session: f.next()?.to_string(),
        pane: f.next()?.to_string(),
        attached: f.next()? == "attached",
        cwd: f.next().unwrap_or_default().to_string(),
        command: command_name(f.next().unwrap_or_default()),
        title: f.next().unwrap_or_default().to_string(),
    };
    (!info.session.is_empty()).then_some(info)
}

/// What to call the program in a pane. Claude Code sets its process title to
/// its own version, so tmux reports `2.1.280` where the terminal user typed
/// `claude`; a bare dotted version is taken to be that.
fn command_name(command: &str) -> String {
    let is_version = command.contains('.')
        && command
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if is_version {
        "claude".to_string()
    } else {
        command.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{file_names, resolve};
    use std::path::PathBuf;

    #[test]
    fn prefers_an_explicit_binary_over_everything() {
        let picked = resolve(
            Some("/checkout/cli/target/debug/roer".to_string()),
            true,
            Some(PathBuf::from("/home/someone")),
        );
        assert_eq!(picked, "/checkout/cli/target/debug/roer");
    }

    #[test]
    fn uses_the_bare_name_when_path_has_it() {
        assert_eq!(
            resolve(None, true, Some(PathBuf::from("/home/someone"))),
            "roer"
        );
    }

    #[test]
    fn falls_back_to_the_bare_name_when_nothing_is_installed() {
        // A window opened from Finder has a minimal PATH and no install, so
        // the error the user sees should name `roer`, not a guessed path.
        assert_eq!(
            resolve(None, false, Some(PathBuf::from("/nowhere"))),
            "roer"
        );
    }

    #[test]
    fn finds_an_install_under_home_when_path_is_minimal() {
        let dir = std::env::temp_dir().join(format!("roer-bin-{}", std::process::id()));
        let installed = dir.join(".local/bin/roer");
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(&installed, "#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve(None, false, Some(dir.clone())),
            installed.to_string_lossy()
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    use super::parse_line;

    #[test]
    fn parses_a_tsv_row() {
        let got = parse_line("abc123\troer\t%0\tattached\t/tmp/x\tclaude").expect("row");
        assert_eq!(got.id, "abc123");
        assert_eq!(got.session, "roer");
        assert_eq!(got.pane, "%0");
        assert!(got.attached);
        assert_eq!(got.cwd, "/tmp/x");
        assert_eq!(got.command, "claude");
    }

    #[test]
    fn detached_rows_are_not_attached() {
        assert!(
            !parse_line("id\ts\t%1\tdetached\t/tmp\tzsh")
                .expect("row")
                .attached
        );
    }

    #[test]
    fn rejects_rows_without_the_required_fields() {
        assert!(parse_line("").is_none());
        assert!(parse_line("only-an-id").is_none());
    }

    #[test]
    fn tolerates_a_cwd_containing_spaces() {
        let got = parse_line("id\ts\t%0\tdetached\t/tmp/my project\tzsh").expect("row");
        assert_eq!(got.cwd, "/tmp/my project");
    }

    #[test]
    fn reads_the_pane_title_and_keeps_its_tabs() {
        let got = parse_line("id\ts\t%0\tattached\t/tmp\tclaude\t\u{2733} fix\tit").expect("row");
        assert_eq!(got.command, "claude");
        assert_eq!(got.title, "\u{2733} fix\tit");
    }

    #[test]
    fn names_claude_code_by_its_command_rather_than_its_version() {
        let got = parse_line("id\ts\t%0\tattached\t/tmp\t2.1.280\t").expect("row");
        assert_eq!(got.command, "claude");
    }

    #[test]
    fn leaves_other_commands_alone() {
        for command in ["zsh", "node", "python3.12", "1", "2.", ".1", ""] {
            let line = format!("id\ts\t%0\tattached\t/tmp\t{command}");
            assert_eq!(parse_line(&line).expect("row").command, command);
        }
    }

    #[test]
    fn an_older_shim_without_a_title_column_parses_with_an_empty_title() {
        let got = parse_line("id\ts\t%0\tattached\t/tmp\tclaude").expect("row");
        assert_eq!(got.title, "");
    }

    #[test]
    fn a_program_is_found_by_each_extension_pathext_lists() {
        assert_eq!(file_names("gh", None), ["gh"]);
        assert_eq!(file_names("gh", Some(".COM;.EXE;")), ["gh", "gh.COM", "gh.EXE"]);
    }
}
