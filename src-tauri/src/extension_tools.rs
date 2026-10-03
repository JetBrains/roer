//! Extension tools for agents, terminal ↔ app, on the same files as the
//! Generative UI panel's records and receipts.
//!
//! The frontend publishes the tools its extensions registered to
//! ~/.roer/extension-tools.json, which `roer mcp` lists. A call is a record
//! `roer mcp` drops into ~/.roer/extension-calls; this watcher hands it to
//! the frontend as [`EXTENSION_CALL_EVENT`] and removes it, which is how
//! `roer mcp` knows it was taken. The window that claims it first runs the
//! tool and answers with a receipt in ~/.roer/extension-call-receipts, named
//! after the call, for the waiting `roer mcp` to read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const EXTENSION_CALL_EVENT: &str = "roer://extension-call";

/// One call, as `roer mcp` writes it. `args` is the tool's own business.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ExtensionCall {
    pub id: String,
    pub extension: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

fn tools_file() -> PathBuf {
    crate::history::roer_home().join("extension-tools.json")
}

fn calls_dir() -> PathBuf {
    crate::history::roer_home().join("extension-calls")
}

fn receipts_dir() -> PathBuf {
    crate::history::roer_home().join("extension-call-receipts")
}

/// Calls some window has taken on. A browser tab and the desktop window both
/// hear every call; only the first to claim it runs the tool.
static CLAIMED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The id names a receipt file, and it came back from the frontend.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn write_atomic(file: &Path, body: &str) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut partial = file.as_os_str().to_owned();
    partial.push(".partial");
    std::fs::write(&partial, body).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, file).map_err(|e| e.to_string())
}

/// What `roer mcp` lists: `{ extension, name, description, inputSchema }[]`.
#[tauri::command]
pub fn extension_tools_publish(tools: Vec<Value>) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&serde_json::json!({ "tools": tools })).map_err(|e| e.to_string())?;
    write_atomic(&tools_file(), &body)
}

/// Whether this window is the one to run call `id`: true for the first to ask.
#[tauri::command]
pub fn extension_call_claim(id: String) -> bool {
    let mut claimed = CLAIMED.lock().unwrap_or_else(|e| e.into_inner());
    let set = claimed.get_or_insert_with(HashSet::new);
    // Calls are few and their ids never come back; this only bounds a very long run.
    if set.len() > 10_000 {
        set.clear();
    }
    set.insert(id)
}

/// The answer to call `id`: what the tool returned, or why it failed.
#[tauri::command]
pub fn extension_call_reply(id: String, result: Option<Value>, error: Option<String>) -> Result<(), String> {
    if !safe_id(&id) {
        return Err(format!("not an extension call id: {id}"));
    }
    let body = match error {
        Some(error) => serde_json::json!({ "error": error }),
        None => serde_json::json!({ "result": result.unwrap_or(Value::Null) }),
    };
    write_atomic(&receipts_dir().join(format!("{id}.json")), &body.to_string())
}

pub fn watch<S: crate::events::Sink>(app: S) -> notify::Result<()> {
    crate::plugin_ui::watch_records::<ExtensionCall, S>(app, calls_dir(), EXTENSION_CALL_EVENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_record_roer_mcp_writes() {
        let raw = r#"{"id":"20261003T120000-42-0","extension":"code-review","tool":"add_comments",
            "args":{"comments":[]},"pane":"%3","cwd":"/repo"}"#;
        let call: ExtensionCall = serde_json::from_str(raw).unwrap();
        assert_eq!((call.extension.as_str(), call.tool.as_str()), ("code-review", "add_comments"));
        assert_eq!(call.pane.as_deref(), Some("%3"));
    }

    #[test]
    fn a_call_is_claimed_once() {
        assert!(extension_call_claim("claim-once".into()));
        assert!(!extension_call_claim("claim-once".into()));
    }

    #[test]
    fn refuses_an_id_that_is_not_a_file_name() {
        assert!(safe_id("20261003T120000-42-0"));
        assert!(!safe_id("../sessions"));
        assert!(!safe_id(""));
    }
}
