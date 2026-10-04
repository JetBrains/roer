//! The files the app watches: handoffs, plugin UI messages and PR drafts.
//! Each is written under a `.partial` name and renamed into place, so the
//! app's watcher can never observe a half-written record.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::Fail;

/// `$ROER_HOME`, or `~/.roer`.
pub fn home() -> PathBuf {
    if let Some(dir) = std::env::var_os("ROER_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    user_home().join(".roer")
}

pub fn user_home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_default()
}

/// A record's name: when, and which process. Sorted by name is sorted by
/// time, which is the order the app replays pending handoffs in. UTC, where
/// the shell shim used local time; nothing reads the stamp back as a time.
pub fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days as i64);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}-{}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        std::process::id()
    )
}

/// Now as RFC 3339 in UTC, to the second: what a task says it was touched.
pub fn now_rfc3339() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Days since 1970-01-01 as a calendar date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
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

/// Writes `text` to `path` through a `.partial` sibling and a rename.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), Fail> {
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    std::fs::write(&partial, text)
        .and_then(|()| std::fs::rename(&partial, path))
        .map_err(|e| Fail::new(1, format!("could not write {}: {e}", path.display())))
}

fn ensure_dir(dir: &Path) -> Result<(), Fail> {
    std::fs::create_dir_all(dir)
        .map_err(|e| Fail::new(1, format!("could not create {}: {e}", dir.display())))
}

/// Drops one A2UI v1.0 message into the app's Plugin UI watcher, tagged with
/// the pane it belongs to. Fire and forget: no claim, ack or timeout. `seq`
/// keeps two messages from one process in one second — a `load`'s
/// deleteSurface and its createSurface — from sharing a filename.
/// `seq` orders one command's messages; the count keeps apart the records of
/// a process that sends several in the same second, as `roer mcp` does, where
/// the stamp alone would have a later one overwrite one not yet delivered.
///
/// Returns the record's id, its file name without `.json`, which the app
/// names the receipt it answers with after: see [`await_plugin_ui`].
pub fn emit_plugin_ui(pane: &str, message: Value, seq: u32) -> Result<String, Fail> {
    static SENT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let count = SENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = home().join("plugin-ui");
    ensure_dir(&dir)?;
    let id = format!("{}-{count}-{seq}", stamp());
    let file = dir.join(format!("{id}.json"));
    write_atomic(&file, &format!("{}\n", json!({ "id": id, "pane": pane, "message": message })))?;
    Ok(id)
}

/// What became of plugin UI records, as far as this side can tell.
#[derive(Debug, PartialEq)]
pub enum Delivery {
    /// The app's panel answered: `outcome` is what it did with the message,
    /// and `on_screen` the pane it was showing, when it knew one.
    Answered { outcome: String, on_screen: Option<String> },
    /// The app took the record but said nothing about it: an app from
    /// before receipts, or a window that is not listening.
    Taken,
    /// Nothing took the record in time, so nothing is watching for it. The
    /// record is removed: the app never replays old ones.
    Unread,
}

/// How long an app has to take a record, and then to answer for it. An app
/// from before receipts takes records and never answers, so the second wait
/// is kept short: it is paid on every call there.
/// `ROER_UI_WAIT_MS` overrides the first, and 0 skips waiting at all.
const PICKUP: Duration = Duration::from_secs(3);
const ANSWER: Duration = Duration::from_millis(1500);

/// Waits for the app to take and answer for each of `ids`, in order,
/// consuming the receipts. None when waiting is switched off.
pub fn await_plugin_ui(ids: &[String]) -> Option<Vec<Delivery>> {
    let pickup = match std::env::var("ROER_UI_WAIT_MS").ok().and_then(|ms| ms.parse().ok()) {
        Some(0) => return None,
        Some(ms) => Duration::from_millis(ms),
        None => PICKUP,
    };
    let records = home().join("plugin-ui");
    let receipts = home().join("plugin-ui-receipts");
    let record = |id: &str| records.join(format!("{id}.json"));
    let receipt = |id: &str| receipts.join(format!("{id}.json"));

    let start = std::time::Instant::now();
    let mut taken_at = None;
    loop {
        let all_taken = ids.iter().all(|id| !record(id).exists());
        if all_taken && taken_at.is_none() {
            taken_at = Some(std::time::Instant::now());
        }
        let answered = ids.iter().all(|id| receipt(id).exists());
        let gave_up = match taken_at {
            Some(at) => at.elapsed() >= ANSWER,
            None => start.elapsed() >= pickup,
        };
        if answered || gave_up {
            break;
        }
        std::thread::sleep(TICK);
    }

    Some(
        ids.iter()
            .map(|id| {
                if let Ok(text) = std::fs::read_to_string(receipt(id)) {
                    let _ = std::fs::remove_file(receipt(id));
                    let answer: Value = serde_json::from_str(&text).unwrap_or_default();
                    return Delivery::Answered {
                        outcome: answer["outcome"].as_str().unwrap_or("unknown").to_string(),
                        on_screen: answer["onScreen"].as_str().map(str::to_string),
                    };
                }
                // Whoever removes the record first has it: the app on taking
                // it, or this, on giving up on it.
                if std::fs::remove_file(record(id)).is_ok() {
                    Delivery::Unread
                } else {
                    Delivery::Taken
                }
            })
            .collect(),
    )
}

/// Hands a drafted PR title and body to the form in the app's Changes tab that opens one.
pub fn emit_pr_draft(pane: &str, draft: Value) -> Result<(), Fail> {
    let dir = home().join("pr-draft");
    ensure_dir(&dir)?;
    let file = dir.join(format!("{}.json", stamp()));
    write_atomic(&file, &format!("{}\n", json!({ "pane": pane, "draft": draft })))
}

/// Hands a drafted commit message, subject as `title`, to the commit box over the local changes in the app's
/// Changes tab. It rides with the pull request drafts, marked as a commit's.
pub fn emit_commit_draft(pane: &str, draft: Value) -> Result<(), Fail> {
    let dir = home().join("pr-draft");
    ensure_dir(&dir)?;
    let file = dir.join(format!("{}.json", stamp()));
    write_atomic(&file, &format!("{}\n", json!({ "pane": pane, "kind": "commit", "draft": draft })))
}

/// How long Roer has to pick a record up, and then how long it may take to
/// get the session on screen. Attaching is allowed to be the slower half: by
/// then the handoff is Roer's, and giving up on it is what is dangerous.
const PENDING: Duration = Duration::from_secs(10);
const CLAIMED: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_millis(100);

/// Writes a handoff for the app and waits for it to be picked up. The record
/// carries the `roer` arguments the app should run, so session semantics stay
/// here rather than being duplicated in the app.
///
/// Each state is reached by one atomic rename or unlink in one directory:
///
/// ```text
///   <file>           pending — written, nobody has it yet
///   <file>.claimed   Roer has it and is attaching
///   <file>.failed    Roer tried and could not; the session never moved
///   gone             Roer is showing the session; the terminal may let go
/// ```
///
/// The claim is what makes giving up safe. Deleting a pending record does not
/// recall a handoff Roer has already been told about — it would attach anyway
/// and evict a terminal that had just been told nothing moved. So the cancel
/// is a rename: whoever renames first wins, and if Roer got there we stop
/// treating the wait as ours to abandon.
pub fn publish(args: &[&str], label: &str, cwd: &str) -> Result<(), Fail> {
    let dir = home().join("handoffs");
    ensure_dir(&dir)?;
    let file = dir.join(format!("{}.json", stamp()));
    let record = json!({ "args": args, "cwd": cwd, "label": label });
    write_atomic(&file, &format!("{}\n", serde_json::to_string_pretty(&record).unwrap_or_default()))?;

    launch_app();

    let suffixed = |suffix: &str| {
        let mut name = file.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    let (claimed, failed, cancelled) = (suffixed(".claimed"), suffixed(".failed"), suffixed(".cancelled"));

    // Phase 1: wait for Roer to claim the record.
    wait_while(&file, PENDING);
    // Cancel by rename, so it cannot half-happen: if it succeeds the record is
    // ours again and a Roer that wakes up later finds nothing to claim. If it
    // fails, Roer claimed it in the last tick — the outcome we were waiting
    // for — so carry on into phase 2.
    if file.exists() && std::fs::rename(&file, &cancelled).is_ok() {
        let _ = std::fs::remove_file(&cancelled);
        // Nothing has moved: a handoff still has its terminal, and a session
        // opened for the app is still sitting there detached.
        return Err(Fail::new(4, "Roer did not take the session within 10s; nothing moved"));
    }

    // Phase 2: Roer deletes the record once the session is really on screen,
    // the only point at which the terminal may let go.
    wait_while(&claimed, CLAIMED);
    if claimed.exists() {
        let _ = std::fs::remove_file(&claimed);
        return Err(Fail::new(4, "Roer took the session but never showed it; nothing moved"));
    }
    if failed.exists() {
        let _ = std::fs::remove_file(&failed);
        return Err(Fail::new(4, "Roer could not open the session; nothing moved"));
    }
    // Gone without a trace is success: Roer deleted the record itself.
    Ok(())
}

fn wait_while(path: &Path, limit: Duration) {
    let mut waited = Duration::ZERO;
    while path.exists() && waited < limit {
        std::thread::sleep(TICK);
        waited += TICK;
    }
}

/// Starts the Roer app, or brings forward the one already running.
///
/// `open` is the only route macOS 14 and later honours for that: an app
/// cannot pull itself in front of a terminal, because the frontmost app has
/// to yield activation and a terminal never does. `open` needs a bundle, so
/// from a checkout set ROER_APP to one — `tauri dev` builds a bare executable
/// that LaunchServices cannot address. On Linux there is no LaunchServices:
/// the app binary is started directly, and a second start is handed to the
/// running instance by its single-instance plugin, and Windows does the same
/// with the installed `roer-app.exe`. Failure is never fatal: a
/// running instance is watching the handoff directory either way.
fn launch_app() {
    use std::process::{Command, Stdio};
    let app = std::env::var("ROER_APP").ok().filter(|v| !v.is_empty());
    if cfg!(target_os = "macos") {
        let _ = Command::new("open")
            .arg("-a")
            .arg(app.as_deref().unwrap_or("Roer"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        return;
    }
    if cfg!(windows) {
        // The installer puts roer in the app's own folder, as `roer\roer.exe`,
        // so the app is one level up wherever it was installed; a roer from
        // the separate CLI zip falls back to the per-user install location.
        // Started directly: a Windows child outlives its parent anyway, and a
        // second start is handed to the running instance like on Linux.
        let beside = std::env::current_exe()
            .ok()
            .and_then(|exe| Some(exe.parent()?.parent()?.join("roer-app.exe")))
            .filter(|app| app.is_file());
        let app = app.map(PathBuf::from).or(beside).or_else(|| {
            std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("Roer").join("roer-app.exe"))
        });
        if let Some(app) = app.filter(|app| app.is_file()) {
            let _ = Command::new(app).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        }
        return;
    }
    // Detached through nohup, so the app outlives this shell and never writes
    // into the terminal the session is leaving.
    let _ = Command::new("sh")
        .arg("-c")
        .arg(r#"command -v "$0" >/dev/null 2>&1 && nohup "$0" >/dev/null 2>&1 &"#)
        .arg(app.as_deref().unwrap_or("roer-app"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_days_to_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_723), (2024, 1, 1));
        assert_eq!(civil(20_720), (2026, 9, 24));
        // Leap day.
        assert_eq!(civil(19_782), (2024, 2, 29));
    }

    #[test]
    fn stamps_sort_as_the_shell_shim_did() {
        let stamp = stamp();
        let (time, pid) = stamp.split_once('-').unwrap();
        assert_eq!(time.len(), "20260101T000000".len());
        assert_eq!(&time[8..9], "T");
        assert_eq!(pid, std::process::id().to_string());
    }
}
