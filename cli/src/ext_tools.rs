//! Extensions' tools, as `roer mcp` offers them: the app publishes what its
//! extensions registered to ~/.roer/extension-tools.json, and a call goes to
//! the app as a record in ~/.roer/extension-calls, answered by a receipt in
//! ~/.roer/extension-call-receipts — the same shape as a Generative UI
//! message and its receipt, so agents reach the app one way.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use crate::records::{home, stamp, write_atomic};
use crate::Fail;

/// Between an extension's id and its tool's name, in the name agents see.
pub const SEPARATOR: &str = "__";

/// How long the app has to take a call, and then to answer it.
const PICKUP: Duration = Duration::from_secs(3);
const ANSWER: Duration = Duration::from_secs(120);
const TICK: Duration = Duration::from_millis(50);

pub fn tools_file() -> PathBuf {
    home().join("extension-tools.json")
}

/// One published tool.
pub struct Tool {
    pub extension: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// What the app last published; nothing when it never has.
pub fn published() -> Vec<Tool> {
    let Ok(text) = std::fs::read_to_string(tools_file()) else { return Vec::new() };
    let value: Value = serde_json::from_str(&text).unwrap_or_default();
    value["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            Some(Tool {
                extension: tool["extension"].as_str()?.to_string(),
                name: tool["name"].as_str()?.to_string(),
                description: tool["description"].as_str().unwrap_or_default().to_string(),
                input_schema: match &tool["inputSchema"] {
                    Value::Object(_) => tool["inputSchema"].clone(),
                    _ => json!({ "type": "object", "properties": {} }),
                },
            })
        })
        .collect()
}

/// When the list was last written, to tell an agent it changed.
pub fn published_at() -> Option<SystemTime> {
    std::fs::metadata(tools_file()).and_then(|m| m.modified()).ok()
}

/// `name` split into an extension's id and its tool, when it is one.
pub fn split(name: &str) -> Option<(&str, &str)> {
    name.split_once(SEPARATOR).filter(|(extension, tool)| !extension.is_empty() && !tool.is_empty())
}

/// Hands one call to the app and waits for its answer: the tool's result as
/// text, or what went wrong as the error.
pub fn call(extension: &str, tool: &str, args: Value, pane: Option<&str>, cwd: &str) -> Result<String, Fail> {
    static SENT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let count = SENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("{}-{count}", stamp());
    let calls = home().join("extension-calls");
    std::fs::create_dir_all(&calls).map_err(|e| Fail::new(1, format!("could not create {}: {e}", calls.display())))?;
    let record = calls.join(format!("{id}.json"));
    let receipt = home().join("extension-call-receipts").join(format!("{id}.json"));
    let body = json!({ "id": id, "extension": extension, "tool": tool, "args": args, "pane": pane, "cwd": cwd });
    write_atomic(&record, &body.to_string())?;

    let start = Instant::now();
    while record.exists() {
        if start.elapsed() >= PICKUP {
            // Whoever removes it first has it: the app on taking it, or this on giving up.
            if std::fs::remove_file(&record).is_ok() {
                return Err(Fail::new(3, "Roer did not pick up the call: is the Roer app running?"));
            }
            break;
        }
        std::thread::sleep(TICK);
    }
    let taken = Instant::now();
    while !receipt.exists() {
        if taken.elapsed() >= ANSWER {
            return Err(Fail::new(
                3,
                format!("{extension}{SEPARATOR}{tool} did not answer within {}s: is a Roer window open?", ANSWER.as_secs()),
            ));
        }
        std::thread::sleep(TICK);
    }
    let text = std::fs::read_to_string(&receipt).unwrap_or_default();
    let _ = std::fs::remove_file(&receipt);
    answer(&text)
}

/// A receipt read back: `{ "result": … }` or `{ "error": "…" }`.
fn answer(text: &str) -> Result<String, Fail> {
    let value: Value = serde_json::from_str(text).map_err(|e| Fail::new(1, format!("unreadable answer: {e}")))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(Fail::new(1, error.to_string()));
    }
    Ok(match value.get("result") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_tool_name_into_extension_and_tool() {
        assert_eq!(split("code-review__add_comments"), Some(("code-review", "add_comments")));
        assert_eq!(split("show_ui"), None);
        assert_eq!(split("__x"), None);
    }

    #[test]
    fn reads_a_result_or_an_error() {
        assert_eq!(answer(r#"{"result":"Added 2."}"#).unwrap(), "Added 2.");
        assert_eq!(answer(r#"{"result":{"n":2}}"#).unwrap(), r#"{"n":2}"#);
        assert_eq!(answer(r#"{"error":"no such tool"}"#).unwrap_err().message, "no such tool");
    }
}
