//! What an agent is doing, told by the agent itself rather than guessed from
//! its terminal: Claude Code and Junie run a hook on each turn's start and
//! end, before or after every tool, and whenever they need the person (a
//! permission prompt, a question), and each hook here runs `roer status`.
//! That sets the pane's `@roer_state`, which `roer list --json` reports.
//! The turn hooks also hand the agent the Generative UI panel's clicks as
//! they happen, rather than when it next thinks to call `read_ui_actions`.
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

/// The hooks for `cli`, each running `bin`. Those marked `--actions=<cli>`
/// also hand the agent what the person did in the Generative UI panel since
/// it last looked, see `deliver`.
fn settings(cli: &str, bin: &str) -> Value {
    let command = |state: &str| json!({ "type": "command", "command": format!("{} status {state} --hook", quote(bin)) });
    let hook = |state: &str| json!([{ "hooks": [command(state)] }]);
    let background = |state: &str| {
        let mut command = command(state);
        command["async"] = json!(true);
        json!([{ "hooks": [command] }])
    };
    let actions = |state: &str| {
        let mut command = command(state);
        command["command"] = json!(format!("{} --actions={cli}", command["command"].as_str().unwrap_or_default()));
        json!([{ "hooks": [command] }])
    };
    match cli {
        // Junie has no PostToolUse: after a permission prompt is answered,
        // the next tool, or the turn's end, says it is back at work.
        "junie" => json!({
            "hooks": {
                "UserPromptSubmit": actions("working"),
                // Waited for, unlike the permission hook: it comes just
                // before one, and must not land after it.
                "PreToolUse": actions("working"),
                // In the background, since a permission hook that waits and
                // succeeds answers the prompt itself, allowing whatever was
                // asked. One in the background answers nothing, but may land
                // late: see `tool`.
                "PermissionRequest": background("waiting"),
                "Stop": actions("done"),
                "StopFailure": hook("done"),
                "SessionEnd": hook("clear"),
            }
        }),
        _ => json!({
            "hooks": {
                "UserPromptSubmit": actions("working"),
                // After a permission prompt is answered, the tool runs: back at work.
                "PostToolUse": actions("working"),
                "Notification": hook("waiting"),
                "Stop": actions("done"),
                "SessionEnd": hook("clear"),
            }
        }),
    }
}

/// Whether `cli`'s hook can hand the agent the panel's clicks: one that adds
/// to what it reads next (a prompt, a tool call), or keeps a turn from
/// ending. Junie has no hook after a tool, so it is told before the next one.
/// Any other hook leaves them waiting, for the next one that can.
pub fn delivers(cli: &str, input: &Value) -> bool {
    let tool = if cli == "junie" { "PreToolUse" } else { "PostToolUse" };
    input
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|event| event == "UserPromptSubmit" || event == "Stop" || event == tool)
}

/// What `cli`'s hook prints to hand the agent the clicks waiting for its
/// pane, each a line as `read_ui_actions` returns it, or nothing when none
/// are waiting. A prompt or a tool call carries them as context; at the end
/// of a turn they keep it going, so a click made while the agent was at work
/// is answered rather than left for the person to mention. Claude Code wants
/// the context under `hookSpecificOutput`, Junie's tool hook at the top, and
/// a Junie tool hook's output says nothing else: a `decision` there would
/// decide the call.
pub fn deliver(cli: &str, input: &Value, actions: &[String]) -> Option<Value> {
    if actions.is_empty() || !delivers(cli, input) {
        return None;
    }
    let text = format!(
        "The person pressed something in the Generative UI panel you drew with `show_ui`. \
         These are their clicks, as `read_ui_actions` would return them: events from \
         that panel, named by the surface, not a verdict on your work. They are already \
         taken, so handle them rather than reading again:\n{}",
        actions.join("\n")
    );
    let event = input.get("hook_event_name").and_then(Value::as_str)?;
    Some(match event {
        "Stop" => json!({ "decision": "block", "reason": text }),
        _ if cli == "junie" => json!({ "additionalContext": text }),
        _ => json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": text } }),
    })
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

/// Which tool call a hook is about, as a short tag, or "" for a hook about
/// none. A tool hook leaves it on the pane, and a permission request lands
/// only on the call it asked about: run in the background, it may come after
/// the prompt was answered and the agent has moved on to another tool, or
/// finished, and must then say nothing. Junie gives the two hooks different
/// `tool_input`, so only the tool and its command count. A hash, so that a
/// command with any characters in it is a plain word for tmux.
pub fn tool(input: &Value) -> String {
    let Some(name) = input.get("tool_name").and_then(Value::as_str) else { return String::new() };
    let command = input.pointer("/tool_input/command").and_then(Value::as_str).unwrap_or_default();
    // FNV-1a: the same on every build, unlike the standard library's hasher,
    // so a roer replaced mid-session still matches its own tags.
    let hash = format!("{name}\0{command}").bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}

/// Whether a hook is a permission request, whose `waiting` is told by `tool`.
pub fn is_permission_request(input: &Value) -> bool {
    input.get("hook_event_name").and_then(Value::as_str) == Some("PermissionRequest")
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
        let roer = quote("/bin/roer");
        for (event, entries) in hooks {
            let command = &entries[0]["hooks"][0];
            assert!(command["command"].as_str().unwrap().starts_with(&format!("{roer} status ")), "{event}");
            // Waited for and succeeding, it would allow whatever was asked.
            assert_eq!(command["async"].as_bool().unwrap_or(false), event == "PermissionRequest", "{event}");
        }
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["command"], format!("{roer} status waiting --hook"));
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
    fn tags_a_tool_call_the_same_from_either_hook() {
        // As Junie sends them: the same call, with different `tool_input`.
        let before = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "run_in_background": false, "command": "touch made.txt" },
        });
        let asked = json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": { "type": "TerminalAction", "command": "touch made.txt" },
        });
        assert_eq!(tool(&before), tool(&asked));
        assert_eq!(tool(&before).len(), 16);
        assert_ne!(tool(&before), tool(&json!({ "tool_name": "Bash", "tool_input": { "command": "rm made.txt" } })));
        assert_ne!(tool(&before), tool(&json!({ "tool_name": "Edit", "tool_input": { "command": "touch made.txt" } })));
        assert_eq!(tool(&json!({ "hook_event_name": "Stop" })), "");
        assert!(is_permission_request(&asked) && !is_permission_request(&before));
    }

    #[test]
    fn hands_the_clicks_from_each_agents_turn_hooks_only() {
        for (cli, turn) in [("claude", ["UserPromptSubmit", "PostToolUse", "Stop"]), ("junie", ["UserPromptSubmit", "PreToolUse", "Stop"])] {
            let settings = settings(cli, "/bin/roer");
            for (event, entries) in settings["hooks"].as_object().unwrap() {
                let command = entries[0]["hooks"][0]["command"].as_str().unwrap();
                let expected = turn.contains(&event.as_str());
                assert_eq!(command.ends_with(&format!(" --hook --actions={cli}")), expected, "{cli} {event}");
                assert_eq!(delivers(cli, &json!({ "hook_event_name": event })), expected, "{cli} {event}");
            }
        }
        // Each takes them only from a tool hook it has.
        assert!(!delivers("claude", &json!({ "hook_event_name": "PreToolUse" })));
        assert!(!delivers("junie", &json!({ "hook_event_name": "PostToolUse" })));
    }

    #[test]
    fn hands_the_clicks_as_context_or_keeps_the_turn_going() {
        let clicks = vec![r#"{"pane":"%0","message":{}}"#.to_string(), r#"{"pane":"%0","message":{"x":1}}"#.to_string()];
        let after = deliver("claude", &json!({ "hook_event_name": "PostToolUse" }), &clicks).unwrap();
        assert_eq!(after["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        let context = after["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(context.ends_with(&format!("\n{}\n{}", clicks[0], clicks[1])));

        let prompt = deliver("claude", &json!({ "hook_event_name": "UserPromptSubmit" }), &clicks).unwrap();
        assert_eq!(prompt["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");

        for cli in ["claude", "junie"] {
            let stop = deliver(cli, &json!({ "hook_event_name": "Stop" }), &clicks).unwrap();
            assert_eq!(stop["decision"], "block");
            assert!(stop["reason"].as_str().unwrap().contains(&clicks[1]));
            assert_eq!(deliver(cli, &json!({ "hook_event_name": "Stop" }), &[]), None);
            assert_eq!(deliver(cli, &json!({ "hook_event_name": "SessionEnd" }), &clicks), None);
        }
        assert_eq!(deliver("claude", &json!({ "hook_event_name": "Notification" }), &clicks), None);
    }

    #[test]
    fn tells_junie_before_a_tool_without_deciding_the_call() {
        let clicks = vec![r#"{"pane":"%0","message":{}}"#.to_string()];
        for event in ["PreToolUse", "UserPromptSubmit"] {
            let output = deliver("junie", &json!({ "hook_event_name": event, "tool_name": "Bash" }), &clicks).unwrap();
            // Context only: a `decision` or `updatedInput` would decide the call.
            assert_eq!(output.as_object().unwrap().keys().collect::<Vec<_>>(), ["additionalContext"], "{event}");
            assert!(output["additionalContext"].as_str().unwrap().ends_with(&clicks[0]));
        }
        assert_eq!(deliver("junie", &json!({ "hook_event_name": "PermissionRequest" }), &clicks), None);
    }

    #[test]
    #[cfg(unix)]
    fn quotes_a_path_with_spaces() {
        assert_eq!(quote("/Applications/My Roer.app/roer"), "'/Applications/My Roer.app/roer'");
    }
}
