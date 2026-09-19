//! The terminal → app plugin-UI channel.
//!
//! `roer plugin-ui` drops one A2UI-shaped message into ~/.roer/plugin-ui and
//! returns immediately — unlike a handoff, nothing is waiting on it, so there
//! is no claim, ack or timeout. This module only has to notice a new record,
//! hand its contents to the frontend, and forget it: consuming (deleting) the
//! file on delivery is what stands in for an ack here.
//!
//! Watching a directory rather than adding a Tauri command the shim calls
//! directly keeps the same shape as [`crate::handoff`] and works identically
//! whether the app is reached over `open -a Roer` or is already running.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PLUGIN_UI_EVENT: &str = "roer://plugin-ui";

/// One A2UI-shaped message, tagged with the pane that sent it.
///
/// `message` is passed through untouched: its shape (`surfaceUpdate`,
/// `dataModelUpdate`, `beginRendering`) is the frontend's contract with the
/// agent, not this watcher's, so it travels as an opaque JSON value.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiRecord {
    pub pane: String,
    pub message: serde_json::Value,
}

/// Mirrors the shim's own resolution, `ROER_HOME` included.
pub fn plugin_ui_dir() -> PathBuf {
    let home = match std::env::var("ROER_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".roer"),
    };
    home.join("plugin-ui")
}

fn is_record(path: &Path) -> bool {
    // The shim writes `<name>.json.partial` and renames it into place, so
    // filtering on the extension is also what keeps a partial record from
    // being parsed mid-write.
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

/// Start watching for plugin-UI messages.
///
/// Messages written while the app was down are lost, not queued — there is
/// no pending-fetch command to mirror `handoff_pending`. That is deliberate:
/// a plugin's UI is only ever generated while a session is on screen and an
/// agent is being asked for it, so the app is already up by construction.
pub fn watch(app: AppHandle) -> notify::Result<()> {
    let dir = plugin_ui_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("roer: cannot create {}: {e}", dir.display());
        return Ok(());
    }

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("roer: could not start the plugin-ui watcher: {e}");
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
        Ok(record) => {
            if let Err(e) = app.emit(PLUGIN_UI_EVENT, record) {
                eprintln!("roer: could not deliver a plugin-ui message: {e}");
            }
        }
        // A malformed record must not take the watcher down with it.
        Err(e) => eprintln!("roer: ignoring {}: {e}", path.display()),
    }
    // Fire-and-forget: nothing acks this, so delivering it is the last thing
    // that happens to the file. Leaving it behind would mean the watcher
    // re-delivers on every subsequent event within its `seen` window, or the
    // directory grows without bound across a long session.
    let _ = std::fs::remove_file(path);
}

fn read(path: &Path) -> Result<PluginUiRecord, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_records_are_picked_up() {
        assert!(is_record(Path::new("/tmp/p/20260101T000000-1.json")));
        assert!(!is_record(Path::new(
            "/tmp/p/20260101T000000-1.json.partial"
        )));
        assert!(!is_record(Path::new("/tmp/p/notes.txt")));
    }

    #[test]
    fn reads_a_message_and_keeps_it_opaque() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("20260101T000000-1.json");
        std::fs::write(
            &path,
            r#"{"pane": "%3", "message": {"kind": "beginRendering", "surfaceId": "s"}}"#,
        )
        .expect("write record");

        let got = read(&path).expect("parse");
        assert_eq!(got.pane, "%3");
        assert_eq!(got.message["kind"], "beginRendering");
        assert_eq!(got.message["surfaceId"], "s");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_record_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("bad.json");
        std::fs::write(&path, "{ not json").expect("write");
        assert!(read(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
