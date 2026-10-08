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
/// copy; then the one installed with the app; then `PATH`, then the usual
/// install locations under `$HOME`.
pub fn bin() -> String {
    resolve(std::env::var("ROER_BIN").ok(), bundled(), on_path("roer"), home())
}

/// The `roer` installed with the app, with the engine it drives: the Windows
/// installer puts it beside the app in `roer\`, Roer.app carries it in
/// `Contents/MacOS` with its tmux, and the Linux packages in
/// `/usr/lib/Roer/cli`. Preferred over `PATH` so the app always talks to the
/// version it shipped with.
///
/// From an AppImage, the copy `cli_link` makes of it once there is one: the
/// image is mounted afresh at every start and unmounted at exit, and a tmux
/// binding or a link on `PATH` to the `roer` inside it would die with it.
pub(crate) fn bundled() -> Option<PathBuf> {
    let shipped = shipped()?;
    Some(appimage_cli().filter(|copy| copy.is_file()).unwrap_or(shipped))
}

/// The `roer` the app shipped with, where it shipped it.
pub(crate) fn shipped() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    bundled_beside(&exe).filter(|path| path.is_file())
}

/// Where `cli_link` copies an AppImage's `roer` to, with its config and
/// skills beside it: a path that outlives the image's mount. None when this
/// is not an AppImage.
pub(crate) fn appimage_cli() -> Option<PathBuf> {
    appimage()?;
    Some(history::roer_home().join("appimage-cli").join("roer"))
}

/// The AppImage this app runs from, if it runs from one. `$APPIMAGE` and
/// `$APPDIR` alone do not say so: everything the app starts inherits them,
/// sessions and their shells included, so a packaged app started from such a
/// shell would take itself for the AppImage. Only an app inside `$APPDIR` is.
pub(crate) fn appimage() -> Option<PathBuf> {
    let image = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty())?;
    let dir = std::env::var_os("APPDIR").filter(|v| !v.is_empty())?;
    let exe = std::env::current_exe().ok()?;
    appimage_of(PathBuf::from(image), std::path::Path::new(&dir), &exe)
}

fn appimage_of(image: PathBuf, dir: &std::path::Path, exe: &std::path::Path) -> Option<PathBuf> {
    exe.starts_with(dir).then_some(image)
}

/// Where the installed `roer` is, for an app running from `exe`. On macOS
/// only from inside a bundle: `tauri dev` runs the app from
/// `target/debug/roer`, where a `roer` beside it would be the app itself. On
/// Linux from `usr/bin`, which is both `/usr/bin` for the packages and
/// `$APPDIR/usr/bin` inside an AppImage; Tauri keeps resources in
/// `../lib/<productName>` from there.
fn bundled_beside(exe: &std::path::Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    if cfg!(windows) {
        Some(dir.join("roer").join("roer.exe"))
    } else if cfg!(target_os = "macos") && dir.ends_with("Contents/MacOS") {
        Some(dir.join("roer"))
    } else if cfg!(target_os = "linux") && dir.ends_with("usr/bin") {
        Some(dir.parent()?.join("lib/Roer/cli/roer"))
    } else {
        None
    }
}

fn resolve(explicit: Option<String>, bundled: Option<PathBuf>, on_path: bool, home: Option<PathBuf>) -> String {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return explicit;
    }
    if let Some(bundled) = bundled {
        return bundled.to_string_lossy().into_owned();
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
    /// The name of the agent roer started in the session, when it started
    /// one: most agents never title their pane.
    pub agent: String,
    /// What the program in the pane last titled it — Claude Code's summary of
    /// the task. Empty when nothing has, or when the shim predates the column.
    pub title: String,
    /// When the window last printed anything, in seconds since the epoch; 0
    /// when the shim is too old to say (it prints TSV) or the engine cannot.
    pub activity: u64,
    /// Whether it rang the bell where nobody was looking.
    pub bell: bool,
    /// What the agent's own hooks last said it is doing — `working`,
    /// `waiting` or `done` — while it runs; empty when it has no hooks.
    pub state: String,
    /// Its words for what it is waiting for, with `waiting`.
    pub note: String,
    /// When the session was last opened, in seconds since the epoch; 0 when
    /// it never was, or the shim is too old to say.
    pub opened: u64,
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

/// Ends the session `pane` is in, with whatever runs in it — the Sessions
/// list's End session.
#[tauri::command(async)]
pub fn roer_kill(pane: String) -> Result<(), String> {
    let out = crate::process::command(bin())
        .args(["kill", "--pane", &pane])
        .output()
        .map_err(|e| format!("could not run `{} kill`: {e}", bin()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
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
    // `--json` for the activity and the bell; a shim from before it ignores
    // the flag and prints TSV, which `parse_line` reads too.
    let out = crate::process::command(bin())
        .args(["list", "--json"])
        .output()
        .map_err(|e| format!("could not run `{} list`: {e}", bin()))?;

    // `roer list` is intentionally quiet when no server is running, so empty
    // output means "no sessions", not an error.
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_line)
        .collect())
}

/// One JSON row of `roer list --json`.
#[derive(serde::Deserialize)]
struct JsonRow {
    id: String,
    session: String,
    pane: String,
    attached: bool,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    activity: u64,
    #[serde(default)]
    bell: bool,
    #[serde(default)]
    state: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    opened: u64,
}

/// One row of `roer list`: JSON from a shim that knows `--json`, otherwise
/// TSV — id, session, pane, attached|detached, cwd, command, agent, title.
fn parse_line(line: &str) -> Option<SessionInfo> {
    if line.starts_with('{') {
        let row: JsonRow = serde_json::from_str(line).ok()?;
        let info = SessionInfo {
            id: row.id,
            session: row.session,
            pane: row.pane,
            attached: row.attached,
            cwd: row.cwd,
            command: command_name(&row.command),
            agent: row.agent,
            title: row.title,
            activity: row.activity,
            bell: row.bell,
            state: row.state,
            note: row.note,
            opened: row.opened,
        };
        return (!info.session.is_empty()).then_some(info);
    }
    // The title is free text and comes last, so it keeps any tab it contains.
    let mut f = line.splitn(8, '\t');
    let info = SessionInfo {
        id: f.next()?.to_string(),
        session: f.next()?.to_string(),
        pane: f.next()?.to_string(),
        attached: f.next()? == "attached",
        cwd: f.next().unwrap_or_default().to_string(),
        command: command_name(f.next().unwrap_or_default()),
        agent: f.next().unwrap_or_default().to_string(),
        title: f.next().unwrap_or_default().to_string(),
        activity: 0,
        bell: false,
        state: String::new(),
        note: String::new(),
        opened: 0,
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

    #[cfg(target_os = "macos")]
    #[test]
    fn the_app_bundle_carries_roer_but_a_dev_build_does_not() {
        use super::bundled_beside;
        use std::path::Path;
        assert_eq!(
            bundled_beside(Path::new("/Applications/Roer.app/Contents/MacOS/roer-app")),
            Some(PathBuf::from("/Applications/Roer.app/Contents/MacOS/roer"))
        );
        assert_eq!(bundled_beside(Path::new("/checkout/src-tauri/target/debug/roer")), None);
    }

    #[test]
    fn an_appimage_only_from_inside_its_mount() {
        use super::appimage_of;
        use std::path::Path;
        let image = PathBuf::from("/home/me/Apps/Roer_0.8.5_amd64.AppImage");
        assert_eq!(
            appimage_of(image.clone(), Path::new("/tmp/.mount_RoerAb12"), Path::new("/tmp/.mount_RoerAb12/usr/bin/roer-app")),
            Some(image.clone())
        );
        // A packaged app started from a shell that a session of the AppImage's
        // left these variables in.
        assert_eq!(appimage_of(image, Path::new("/tmp/.mount_RoerAb12"), Path::new("/usr/bin/roer-app")), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_packages_and_the_appimage_carry_roer_but_a_dev_build_does_not() {
        use super::bundled_beside;
        use std::path::Path;
        assert_eq!(
            bundled_beside(Path::new("/usr/bin/roer-app")),
            Some(PathBuf::from("/usr/lib/Roer/cli/roer"))
        );
        assert_eq!(
            bundled_beside(Path::new("/tmp/.mount_RoerAb12/usr/bin/roer-app")),
            Some(PathBuf::from("/tmp/.mount_RoerAb12/usr/lib/Roer/cli/roer"))
        );
        assert_eq!(bundled_beside(Path::new("/checkout/src-tauri/target/debug/roer")), None);
    }

    #[test]
    fn prefers_an_explicit_binary_over_everything() {
        let picked = resolve(
            Some("/checkout/cli/target/debug/roer".to_string()),
            Some(PathBuf::from("C:/Program Files/Roer/roer/roer.exe")),
            true,
            Some(PathBuf::from("/home/someone")),
        );
        assert_eq!(picked, "/checkout/cli/target/debug/roer");
    }

    #[test]
    fn prefers_the_roer_installed_with_the_app_over_path() {
        let bundled = PathBuf::from("C:/Program Files/Roer/roer/roer.exe");
        assert_eq!(
            resolve(None, Some(bundled.clone()), true, Some(PathBuf::from("/home/someone"))),
            bundled.to_string_lossy()
        );
    }

    #[test]
    fn uses_the_bare_name_when_path_has_it() {
        assert_eq!(
            resolve(None, None, true, Some(PathBuf::from("/home/someone"))),
            "roer"
        );
    }

    #[test]
    fn falls_back_to_the_bare_name_when_nothing_is_installed() {
        // A window opened from Finder has a minimal PATH and no install, so
        // the error the user sees should name `roer`, not a guessed path.
        assert_eq!(
            resolve(None, None, false, Some(PathBuf::from("/nowhere"))),
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
            resolve(None, None, false, Some(dir.clone())),
            installed.to_string_lossy()
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    use super::parse_line;

    #[test]
    fn parses_a_json_row() {
        let got = parse_line(
            r#"{"id":"abc","session":"roer","pane":"%0","attached":false,"cwd":"/tmp","command":"2.1.280","agent":"","title":"\u2733 fix","activity":1790000000,"bell":true,"opened":1790000100}"#,
        )
        .expect("row");
        assert_eq!(got.session, "roer");
        assert_eq!(got.command, "claude");
        assert_eq!(got.title, "\u{2733} fix");
        assert_eq!(got.activity, 1_790_000_000);
        assert_eq!(got.opened, 1_790_000_100);
        assert!(got.bell);
    }

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
        let got = parse_line("id\ts\t%0\tattached\t/tmp\tclaude\tClaude Code\t\u{2733} fix\tit").expect("row");
        assert_eq!(got.command, "claude");
        assert_eq!(got.agent, "Claude Code");
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
