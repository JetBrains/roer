//! Small state that Roer's window and its browser pages share: what a tab
//! keeps that must read the same wherever it is open, such as a branch's
//! review comments in Changes. A page's own `localStorage` cannot do that:
//! the window and a browser page are different origins, each with its own.
//!
//! One JSON object of string values in `$ROER_HOME/shared-state.json`, read
//! whole and written whole (it holds a few kilobytes), and every change told
//! to the window and to the browser server's pages as `roer://shared-state`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

/// Told to every view when a key changes: `{ key, value }`, value null when removed.
pub const EVENT: &str = "roer://shared-state";

/// One writer at a time in this process: the window's commands and the
/// in-process server's both land here.
static LOCK: Mutex<()> = Mutex::new(());

fn file() -> PathBuf {
    crate::history::roer_home().join("shared-state.json")
}

fn read(file: &std::path::Path) -> Map<String, Value> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn write(file: &std::path::Path, map: &Map<String, Value>) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut partial = file.as_os_str().to_owned();
    partial.push(".partial");
    std::fs::write(&partial, serde_json::to_string(map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, file).map_err(|e| e.to_string())
}

/// Every key and its value.
pub fn all() -> Map<String, Value> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(&file())
}

/// Sets `key` to `value`, or removes it with none, and returns the event's
/// payload for the caller to tell every view.
pub fn set(key: String, value: Option<String>) -> Result<Value, String> {
    set_in(&file(), key, value)
}

fn set_in(file: &std::path::Path, key: String, value: Option<String>) -> Result<Value, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read(file);
    match &value {
        Some(value) => map.insert(key.clone(), Value::String(value.clone())),
        None => map.remove(&key),
    };
    write(file, &map)?;
    Ok(serde_json::json!({ "key": key, "value": value }))
}

#[tauri::command]
pub fn shared_state_all() -> Map<String, Value> {
    all()
}

/// The window's own: also told to the browser server's pages.
#[tauri::command]
pub fn shared_state_set(app: tauri::AppHandle, key: String, value: Option<String>) -> Result<(), String> {
    let change = set(key, value)?;
    crate::server::DesktopWatchSink(app).emit_change(&change);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_set_read_back_and_removed() {
        let dir = std::env::temp_dir().join(format!("roer-shared-state-{}", std::process::id()));
        let file = dir.join("shared-state.json");
        assert_eq!(set_in(&file, "a".into(), Some("1".into())).unwrap(), serde_json::json!({ "key": "a", "value": "1" }));
        set_in(&file, "b".into(), Some("2".into())).unwrap();
        assert_eq!(read(&file).get("a"), Some(&Value::String("1".into())));
        set_in(&file, "a".into(), None).unwrap();
        assert_eq!(read(&file).keys().cloned().collect::<Vec<_>>(), vec!["b".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
