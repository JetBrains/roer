//! What an agent is doing, told by the agent itself rather than guessed from
//! its terminal: Claude Code and Junie run a hook on each turn's start and
//! end, before or after every tool, and whenever they need the person (a
//! permission prompt, a question), and each hook here runs `roer status`.
//! That sets the pane's `@roer_state`, which `roer list --json` reports.
//!
//! The hooks reach the agent through a flag on the line roer starts it with
//! (`--settings` for Claude Code, `--config-location` for Junie, both added
//! to the agent's own settings), so only a session roer started has them, and
//! nothing in `~/.claude` or `~/.junie` changes. An agent typed by hand keeps
//! the app's other signals: its title, its output, its bell.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::{records, Fail};

/// The states a hook reports. `waiting` is the agent asking for something;
/// `done` is a turn that finished; `clear` forgets, as the session ends.
pub const STATES: &[&str] = &["working", "waiting", "done", "clear"];

/// How much of a notification's text is kept: one line, for a row's tooltip
/// and a notification's body.
const NOTE_CHARS: usize = 200;

/// Where a CLI's settings file goes: one for every session of it, rewritten
/// each time one starts so it always names the `roer` that started it.
pub fn settings_path(cli: &str) -> PathBuf {
    records::home().join(format!("{cli}-status.json"))
}

/// The hooks for `cli`, each running `bin`.
fn settings(cli: &str, bin: &str) -> Value {
    let command = |state: &str| json!({ "type": "command", "command": format!("{} status {state} --hook", quote(bin)) });
    let hook = |state: &str| json!([{ "hooks": [command(state)] }]);
    let background = |state: &str| {
        let mut command = command(state);
        command["async"] = json!(true);
        json!([{ "hooks": [command] }])
    };
    match cli {
        // Junie has no PostToolUse: after a permission prompt is answered,
        // the next tool, or the turn's end, says it is back at work.
        "junie" => json!({
            "hooks": {
                "UserPromptSubmit": hook("working"),
                // Waited for, unlike the permission hook: it comes just
                // before one, and must not land after it.
                "PreToolUse": hook("working"),
                // In the background, since a permission hook that waits and
                // succeeds answers the prompt itself, allowing whatever was
                // asked. One in the background answers nothing.
                "PermissionRequest": background("waiting"),
                "Stop": hook("done"),
                "StopFailure": hook("done"),
                "SessionEnd": hook("clear"),
            }
        }),
        _ => json!({
            "hooks": {
                "UserPromptSubmit": hook("working"),
                // After a permission prompt is answered, the tool runs: back at work.
                "PostToolUse": hook("working"),
                "Notification": hook("waiting"),
                "Stop": hook("done"),
                "SessionEnd": hook("clear"),
            }
        }),
    }
}

/// Writes `cli`'s settings file, with each hook running `bin`.
pub fn write(cli: &str, bin: &str) -> Result<PathBuf, Fail> {
    let path = settings_path(cli);
    let settings = settings(cli, bin);
    let fail = |e: std::io::Error| Fail::new(1, format!("could not write {}: {e}", path.display()));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    // Whole or not at all: another session starting at the same moment may
    // be handing this file to its own agent, which must never read it half
    // written. A rename replaces it in one step.
    let partial = path.with_extension(format!("json.{}.partial", std::process::id()));
    let text = format!("{}\n", serde_json::to_string_pretty(&settings).unwrap_or_default());
    std::fs::write(&partial, text).map_err(fail)?;
    std::fs::rename(&partial, &path).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        fail(e)
    })?;
    Ok(path)
}

/// The one line of a hook's input worth showing: Claude Code's own words for
/// what it needs ("Claude needs your permission to use Bash"), or for Junie,
/// which gives none, what its permission prompt is about, with nothing in it
/// that would break a tab-separated row.
pub fn note(input: &Value) -> String {
    let text = match input.get("message").and_then(Value::as_str) {
        Some(message) => message.to_string(),
        None if input.get("hook_event_name").and_then(Value::as_str) == Some("PermissionRequest") => {
            let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or_default();
            match input.pointer("/tool_input/command").and_then(Value::as_str) {
                Some(command) => format!("Junie needs your permission to run {command}"),
                None if !tool.is_empty() => format!("Junie needs your permission to use {tool}"),
                None => "Junie needs your permission".to_string(),
            }
        }
        None => String::new(),
    };
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(NOTE_CHARS).collect()
}

/// Whether a `Notification` hook asks the person for nothing: Claude Code's
/// reminder that a finished turn is still unanswered, a minute after `Stop`,
/// or word that a login worked. The turn stays as it was. Told by its type
/// where Claude Code sends one, and by its words where it does not.
pub fn asks_nothing(input: &Value) -> bool {
    match input.get("notification_type").and_then(Value::as_str) {
        Some(kind) => matches!(kind, "idle_prompt" | "auth_success"),
        None => input
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("waiting for your input")),
    }
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
    fn says_what_junie_asks_permission_for() {
        let bash = json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": { "command": "touch\nmade.txt" },
            "permission_reason": "bash_command",
        });
        assert_eq!(note(&bash), "Junie needs your permission to run touch made.txt");
        let edit = json!({ "hook_event_name": "PermissionRequest", "tool_name": "Edit", "tool_input": {} });
        assert_eq!(note(&edit), "Junie needs your permission to use Edit");
        assert_eq!(note(&json!({ "hook_event_name": "Stop" })), "");
    }

    #[test]
    fn asks_junie_permission_in_the_background_only() {
        let junie = settings("junie", "/bin/roer");
        let hooks = junie["hooks"].as_object().unwrap();
        for (event, entries) in hooks {
            let command = &entries[0]["hooks"][0];
            assert!(command["command"].as_str().unwrap().starts_with("'/bin/roer' status "), "{event}");
            // Waited for and succeeding, it would allow whatever was asked.
            assert_eq!(command["async"].as_bool().unwrap_or(false), event == "PermissionRequest", "{event}");
        }
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["command"], "'/bin/roer' status waiting --hook");
        assert!(!hooks.contains_key("Notification"));
        assert!(settings("claude", "/bin/roer")["hooks"].get("PermissionRequest").is_none());
    }

    #[test]
    fn tells_a_request_from_a_reminder() {
        assert!(asks_nothing(&json!({ "notification_type": "idle_prompt", "message": "Claude is waiting for your input" })));
        assert!(asks_nothing(&json!({ "message": "Claude is waiting for your input" })));
        assert!(asks_nothing(&json!({ "notification_type": "auth_success", "message": "Authenticated" })));
        assert!(!asks_nothing(&json!({ "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" })));
        assert!(!asks_nothing(&json!({ "message": "Claude needs your permission to use Bash" })));
        assert!(!asks_nothing(&json!({})));
    }

    #[test]
    #[cfg(unix)]
    fn quotes_a_path_with_spaces() {
        assert_eq!(quote("/Applications/My Roer.app/roer"), "'/Applications/My Roer.app/roer'");
    }
}
