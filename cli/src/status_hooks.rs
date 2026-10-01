//! What an agent is doing, told by the agent itself rather than guessed from
//! its terminal: Claude Code runs a hook on each turn's start and end, after
//! every tool, and whenever it needs the person (a permission prompt, a
//! question), and each hook here runs `roer status`. That sets the pane's
//! `@roer_state`, which `roer list --json` reports.
//!
//! The hooks reach Claude Code through `--settings` on the line roer starts
//! it with, so only a session roer started has them, and nothing in
//! `~/.claude` changes. A `claude` typed by hand keeps the app's other
//! signals: its title, its output, its bell.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::{records, Fail};

/// The states a hook reports. `waiting` is Claude asking for something;
/// `done` is a turn that finished; `clear` forgets, as the session ends.
pub const STATES: &[&str] = &["working", "waiting", "done", "clear"];

/// How much of a notification's text is kept: one line, for a row's tooltip
/// and a notification's body.
const NOTE_CHARS: usize = 200;

/// Where the settings file goes: one for every session, rewritten each time
/// one starts so it always names the `roer` that started it.
pub fn settings_path() -> PathBuf {
    records::home().join("claude-status.json")
}

/// Writes the settings file, with each hook running `bin`.
pub fn write(bin: &str) -> Result<PathBuf, Fail> {
    let path = settings_path();
    let hook = |state: &str| json!([{ "hooks": [{ "type": "command", "command": format!("{} status {state} --hook", quote(bin)) }] }]);
    let settings = json!({
        "hooks": {
            "UserPromptSubmit": hook("working"),
            // After a permission prompt is answered, the tool runs: back at work.
            "PostToolUse": hook("working"),
            "Notification": hook("waiting"),
            "Stop": hook("done"),
            "SessionEnd": hook("clear"),
        }
    });
    let fail = |e: std::io::Error| Fail::new(1, format!("could not write {}: {e}", path.display()));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&settings).unwrap_or_default())).map_err(fail)?;
    Ok(path)
}

/// The one line of a hook's input worth showing: Claude Code's own words for
/// what it needs ("Claude needs your permission to use Bash"), with nothing
/// in it that would break a tab-separated row.
pub fn note(input: &Value) -> String {
    let text = input.get("message").and_then(Value::as_str).unwrap_or_default();
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(NOTE_CHARS).collect()
}

/// A path as one shell word. Claude Code runs a hook's command through a
/// shell, and an app's path can have spaces in it.
fn quote(word: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", word.replace('"', "\\\""))
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_line_of_the_message() {
        let input = json!({ "message": "Claude needs your\npermission to use\tBash" });
        assert_eq!(note(&input), "Claude needs your permission to use Bash");
        assert_eq!(note(&json!({})), "");
    }

    #[test]
    #[cfg(unix)]
    fn quotes_a_path_with_spaces() {
        assert_eq!(quote("/Applications/My Roer.app/roer"), "'/Applications/My Roer.app/roer'");
    }
}
