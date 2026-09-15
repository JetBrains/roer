//! The terminal → app control channel.
//!
//! `roer handoff` drops a JSON record into ~/.roer/handoffs and then waits for
//! that file to disappear. The file vanishing is its signal that Roer holds
//! the session and the terminal may let go, so the record is deleted only once
//! the frontend has actually attached — see [`handoff_ack`]. Acking on receipt
//! instead would release the terminal before anything was showing the session.
//!
//! A watched directory rather than a `roer://` deep link: macOS registers
//! custom URL schemes through Launch Services for installed .app bundles only,
//! so deep links do not fire under `tauri dev`. This path behaves identically
//! in development and in a release build.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

pub const HANDOFF_EVENT: &str = "roer://handoff";

/// A record written by `roer handoff`.
///
/// The shim decides *how* the session is opened and sends the shim arguments
/// to run, so attach-versus-resume semantics live in one shell script instead
/// of being mirrored here and in the frontend.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Handoff {
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub label: String,
    /// Absolute path of the record. The frontend hands this back to ack, so
    /// it is filled in on read rather than by the shim.
    #[serde(default)]
    pub record: String,
}

/// Mirrors the shim's own resolution, `ROER_HOME` included.
pub fn handoffs_dir() -> PathBuf {
    let home = match std::env::var("ROER_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".roer"),
    };
    home.join("handoffs")
}

fn is_record(path: &Path) -> bool {
    // The shim writes `<name>.json.partial` and renames it into place, so
    // filtering on the extension is also what keeps a partial record from
    // being parsed mid-write.
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

/// Start watching for handoffs, after delivering any that arrived while the
/// app was down.
pub fn watch(app: AppHandle) -> notify::Result<()> {
    let dir = handoffs_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("roer: cannot create {}: {e}", dir.display());
        return Ok(());
    }

    for path in pending(&dir) {
        deliver(&app, &path);
    }

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("roer: could not start the handoff watcher: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("roer: could not watch {}: {e}", dir.display());
            return;
        }

        // One rename can surface as several events, so records are delivered
        // once. Entries for files that are gone are dropped first, which both
        // bounds the set and lets a recycled filename through.
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for event in rx.into_iter().flatten() {
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            seen.retain(|path| path.exists());
            for path in event.paths {
                // A rename fires more than one event for the same record, and
                // the ack deletes it between them, so both the `seen` set and
                // the existence check are load-bearing.
                if is_record(&path) && path.exists() && seen.insert(path.clone()) {
                    deliver(&app, &path);
                }
            }
        }
    });

    Ok(())
}

fn deliver(app: &AppHandle, path: &Path) {
    match read(path) {
        Ok(handoff) => {
            if let Err(e) = app.emit(HANDOFF_EVENT, handoff) {
                eprintln!("roer: could not deliver a handoff: {e}");
            }
            // A handoff means "show me this session now", so it is also a
            // request to come forward. The shim's `open -a Roer` cannot be
            // what does this: it finds nothing under `tauri dev`, and even
            // installed it only reaches an app that is not already running.
            focus(app);
        }
        // A malformed record must not take the watcher down with it. Nothing
        // is coming up for it either — stealing focus for a record we could
        // not read would be the wrong half of the behaviour.
        Err(e) => eprintln!("roer: ignoring {}: {e}", path.display()),
    }
}

/// Bring Roer's window to the front, from wherever it was.
///
/// The order is load-bearing: on macOS `set_focus` is `makeKeyAndOrderFront`
/// plus `activateIgnoringOtherApps`, but tao skips all of it when the window
/// is minimized or hidden, so those have to be undone first.
pub fn focus(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("roer: no main window to focus");
        return;
    };
    // set_focus is a no-op on a window that is minimized or hidden, so the
    // window has to be back on screen before it is worth asking for.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // macOS 14 and later arbitrate activation: a request to come forward is
    // granted only if the frontmost app yields it, and a terminal does not.
    // The shim's `open -a` is the route the system does honour, but it needs
    // an app bundle, which a `tauri dev` binary has not got. So the window may
    // stay behind however politely it asks — and then a bouncing Dock icon is
    // the difference between a session you can find and one that opened out of
    // sight. macOS cancels the request itself the moment the app is activated,
    // and ignores it outright when the app is already frontmost.
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));
}

fn read(path: &Path) -> Result<Handoff, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut handoff: Handoff = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    handoff.record = path.to_string_lossy().into_owned();
    Ok(handoff)
}

fn pending(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_record(path))
        .collect();
    // Names lead with a timestamp, so this replays them in arrival order.
    paths.sort();
    paths
}

/// Confirm a handoff is attached, releasing the waiting terminal.
#[tauri::command]
pub fn handoff_ack(record: String) -> Result<(), String> {
    let path = PathBuf::from(&record);
    if !is_record(&path) {
        return Err(format!("not a handoff record: {record}"));
    }
    // The path arrives from the webview, so deletion is confined to the
    // handoff directory rather than trusting it.
    let dir = handoffs_dir()
        .canonicalize()
        .map_err(|e| format!("no handoff directory: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "record has no parent directory".to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent != dir {
        return Err(format!("refusing to delete outside {}", dir.display()));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_records_are_picked_up() {
        assert!(is_record(Path::new("/tmp/h/20260101T000000-1.json")));
        // The shim's in-progress write must be ignored until it is renamed.
        assert!(!is_record(Path::new(
            "/tmp/h/20260101T000000-1.json.partial"
        )));
        assert!(!is_record(Path::new("/tmp/h/notes.txt")));
    }

    #[test]
    fn reads_an_attach_record_and_stamps_its_path() {
        let dir = std::env::temp_dir().join(format!("roer-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("20260101T000000-1.json");
        std::fs::write(
            &path,
            r#"{"args":["attach","%3"],"cwd":"/tmp/x","label":"roer"}"#,
        )
        .expect("write record");

        let got = read(&path).expect("parse");
        assert_eq!(got.args, vec!["attach", "%3"]);
        assert_eq!(got.cwd, "/tmp/x");
        assert_eq!(got.label, "roer");
        assert_eq!(got.record, path.to_string_lossy());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_a_resume_record() {
        let dir = std::env::temp_dir().join(format!("roer-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("r.json");
        std::fs::write(&path, r#"{"args":["resume","abc-123"],"cwd":"/tmp"}"#).expect("write");

        let got = read(&path).expect("parse");
        assert_eq!(got.args, vec!["resume", "abc-123"]);
        // label is optional in the record and defaults rather than failing.
        assert_eq!(got.label, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_record_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("roer-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("bad.json");
        std::fs::write(&path, "{ not json").expect("write");
        assert!(read(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ack_refuses_paths_outside_the_handoff_directory() {
        let outside = std::env::temp_dir().join("roer-outside.json");
        std::fs::write(&outside, "{}").expect("write");
        assert!(handoff_ack(outside.to_string_lossy().into_owned()).is_err());
        // The guard must not have deleted it.
        assert!(outside.exists());
        std::fs::remove_file(&outside).ok();
    }
}
