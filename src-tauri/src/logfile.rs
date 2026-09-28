//! The app's log file: what a user sends when a session will not open or a
//! terminal draws wrong, and Help > Show Logs in Finder is how they find it.
//!
//! An app opened from Finder has a stderr that goes nowhere, so every
//! `eprintln!` in here, a panic's message and whatever a child process
//! complains about used to be lost. When stderr is not a terminal it is
//! pointed at the log file; under `tauri dev` it stays on the terminal that
//! ran the app, and [`line`] writes to both.

use std::fs::{File, OpenOptions};
use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::roer;

/// Past this, the log is moved aside at launch and a new one started, so it
/// stays small enough to attach to an issue.
const ROTATE_AT: u64 = 2 * 1024 * 1024;

struct Log {
    file: File,
    /// stderr is this same file, so writing to both would say it twice.
    redirected: bool,
}

static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

/// Where macOS keeps an app's logs, so Console.app finds them too; elsewhere
/// beside the rest of Roer's state.
pub fn dir() -> PathBuf {
    let home = roer::home().unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        home.join("Library/Logs/Roer")
    } else {
        home.join(".roer/logs")
    }
}

pub fn path() -> PathBuf {
    dir().join("roer.log")
}

/// Opens the log, before anything else runs, and says what this app is and
/// what it will run: most reports turn on a version or a path.
pub fn init() {
    let dir = dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = path();
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > ROTATE_AT) {
        let _ = std::fs::rename(&path, dir.join("roer.1.log"));
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let redirected = !std::io::stderr().is_terminal() && redirect_stderr(&file);
    let _ = LOG.set(Mutex::new(Log { file, redirected }));

    line(&format!("Roer {} started ({}, {})", env!("CARGO_PKG_VERSION"), os(), std::env::consts::ARCH));
    line(&format!("app: {}", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()));
    line(&format!("roer: {} (bundled: {})", roer::bin(), roer::bundled().is_some()));
    for var in ["LANG", "LC_ALL", "LC_CTYPE", "SHELL", "PATH", "ROER_SOCKET"] {
        line(&format!("{var}={}", std::env::var(var).unwrap_or_default()));
    }
    // `roer diagnose` asks tmux, which can take a moment with a busy server.
    std::thread::spawn(diagnose);
}

/// One timestamped line in the log.
pub fn line(message: &str) {
    let text = format!("{} {message}\n", timestamp());
    let Some(log) = LOG.get() else {
        eprint!("{text}");
        return;
    };
    let Ok(mut log) = log.lock() else { return };
    let _ = log.file.write_all(text.as_bytes());
    if !log.redirected {
        eprint!("{text}");
    }
}

/// What `roer diagnose` says right now: the engine, its server and how it
/// sees each client, which is the part of a rendering bug the app cannot see.
pub fn diagnose() {
    match std::process::Command::new(roer::bin()).arg("diagnose").output() {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let err = String::from_utf8_lossy(&out.stderr);
            line(&format!("roer diagnose ({}):\n{}{}", out.status, text, err));
        }
        Err(e) => line(&format!("could not run roer diagnose: {e}")),
    }
}

/// A line from the frontend, which has no file of its own.
#[tauri::command]
pub fn app_log(message: String) {
    line(&format!("ui: {message}"));
}

/// Help > Show Logs in Finder: a fresh diagnosis first, so the log shows the
/// state the user is looking at, then the file selected in Finder, ready to
/// drag into an issue or a message.
pub fn reveal() {
    diagnose();
    let path = path();
    line(&format!("revealing {}", path.display()));
    let opened = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(&path).status()
    } else if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).status()
    } else {
        std::process::Command::new("xdg-open").arg(dir()).status()
    };
    if let Err(e) = opened {
        line(&format!("could not reveal the log: {e}"));
    }
}

#[cfg(unix)]
fn redirect_stderr(file: &File) -> bool {
    use std::os::fd::AsRawFd;
    // SAFETY: both descriptors are open for the duration of the call; dup2
    // only replaces fd 2, which nothing else holds a Rust handle to.
    unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) != -1 }
}

#[cfg(not(unix))]
fn redirect_stderr(_: &File) -> bool {
    false
}

fn os() -> String {
    if cfg!(target_os = "macos") {
        let version = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default();
        format!("macOS {version}")
    } else {
        std::env::consts::OS.to_string()
    }
}

/// UTC, to the millisecond: the log is read next to other people's clocks.
fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let (y, m, d) = civil(secs / 86_400);
    let t = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        t / 3600,
        t / 60 % 60,
        t % 60,
        now.subsec_millis()
    )
}

/// Days since 1970-01-01 as a calendar date (Howard Hinnant's algorithm).
fn civil(days: u64) -> (i64, u32, u32) {
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::civil;

    #[test]
    fn days_become_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(11_016), (2000, 2, 29));
        assert_eq!(civil(20_724), (2026, 9, 28));
    }
}
