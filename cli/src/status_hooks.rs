//! What an agent is doing, told by the agent itself rather than guessed from
//! its terminal: Claude Code and Junie run a hook on each turn's start and
//! end, before or after every tool, and whenever they need the person (a
//! permission prompt, a question), and each hook here runs `roer status`.
//! Pi has no hooks, only extensions: roer hands it one of its own, which runs
//! `roer status` on Pi's events with the input a Claude Code hook would have.
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
    let extension = if cli == "pi" { "ts" } else { "json" };
    records::home().join(format!("{cli}-status.{extension}"))
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
                // Which tool call the agent is at, for a permission request
                // to be matched with; and a question or a plan, which wait
                // on the person without any permission asked.
                "PreToolUse": hook("working"),
                // In the background for the same reason as Junie's: its
                // words say what is asked ("run npm test"), where the
                // notification only names the tool, seconds later.
                "PermissionRequest": background("waiting"),
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
    let partial = path.with_extension(format!("{}.partial", std::process::id()));
    let text = if cli == "pi" {
        PI_EXTENSION.replace("__ROER__", &Value::String(bin.to_string()).to_string())
    } else {
        format!("{}\n", serde_json::to_string_pretty(&settings).unwrap_or_default())
    };
    std::fs::write(&partial, text).map_err(fail)?;
    std::fs::rename(&partial, &path).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        fail(e)
    })?;
    Ok(path)
}

/// Roer's extension for a Pi session it started: what Pi is doing, told to
/// `roer status` as a Claude Code hook would tell it. Pi asks no permission
/// for its tools, so it waits on the person only for an extension's prompt;
/// a run is over at `agent_settled`, after which nothing continues it on its
/// own, where `agent_end` can be followed by a retry or a compaction.
const PI_EXTENSION: &str = r#"// Written by roer for the Pi sessions it starts; rewritten each time one does.
import { execFile } from "node:child_process";

const ROER = __ROER__;

// One call at a time, in the order Pi's events came: run side by side, a
// `working` could land after the `done` that followed it, and stay.
let queue: Promise<void> = Promise.resolve();

// The call, once it has run: what Pi waits on at shutdown, where it may exit right after.
function status(state: string, input: Record<string, unknown>): Promise<void> {
  queue = queue.then(
    () =>
      new Promise<void>((done) => {
        try {
          const child = execFile(ROER, ["status", state, "--hook"], () => done());
          child.stdin?.end(JSON.stringify(input));
        } catch {
          // Outside a roer session, or without roer: nothing to tell.
          done();
        }
      }),
  );
  return queue;
}

/** The text of the run's last reply; none for one stopped by the person or by an error, which sums nothing up. */
function lastReply(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown; stopReason?: unknown };
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") return "";
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .filter((part: { type?: string; text?: unknown }) => part?.type === "text" && typeof part.text === "string")
      .map((part: { text: string }) => part.text)
      .join("\n");
  }
  return "";
}

export default function (pi: { on: (event: string, handler: (event: any) => unknown) => void }): void {
  let running = false;
  let reply = "";
  pi.on("agent_start", () => {
    running = true;
    status("working", { hook_event_name: "UserPromptSubmit" });
  });
  pi.on("ui_prompt_start", (event) => {
    const title = typeof event?.title === "string" ? event.title.trim() : "";
    status("waiting", { hook_event_name: "Notification", message: title ? `Asks: ${title}` : "Pi needs your input" });
  });
  // Back at work, or, for a prompt outside a run, nothing to say.
  pi.on("ui_prompt_end", () => status(running ? "working" : "clear", { hook_event_name: "UserPromptSubmit" }));
  pi.on("agent_end", (event) => {
    reply = lastReply(event?.messages);
  });
  // `agent_settled` carries nothing; a run the person stopped is told by its last reply, in `agent_end`.
  pi.on("agent_settled", () => {
    running = false;
    status("done", { hook_event_name: "Stop", last_assistant_message: reply });
    reply = "";
  });
  // Returned, so Pi waits for it before it exits: the pane would keep the run's state otherwise.
  pi.on("session_shutdown", () => status("clear", { hook_event_name: "SessionEnd" }));
}
"#;

/// The one line of a hook's input worth showing, for a row and a
/// notification: what a permission request is for ("Wants to run npm test"),
/// the question asked, the plan to approve, the start of a finished turn's
/// last reply, or else the agent's own words ("Claude needs your permission
/// to use Bash"). Nothing in it breaks a tab-separated row.
pub fn note(input: &Value) -> String {
    let event = input.get("hook_event_name").and_then(Value::as_str).unwrap_or_default();
    let text = match event {
        "PermissionRequest" => wants(input),
        "PreToolUse" => asks(input).unwrap_or_default(),
        "Stop" => input
            .get("last_assistant_message")
            .and_then(Value::as_str)
            .map(gist)
            .unwrap_or_default(),
        _ => input.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
    };
    clip(&text)
}

/// What a permission request asks to do, said the way the tool does it.
fn wants(input: &Value) -> String {
    let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or_default();
    let field = |name: &str| input.pointer(&format!("/tool_input/{name}")).and_then(Value::as_str).filter(|v| !v.is_empty());
    let path = |name: &str| field(name).map(|path| relative(input, path));
    let said = match tool {
        "Bash" | "PowerShell" => field("command").map(|command| format!("Wants to run {command}")),
        "Edit" | "MultiEdit" => path("file_path").map(|path| format!("Wants to edit {path}")),
        "Write" => path("file_path").map(|path| format!("Wants to write {path}")),
        "NotebookEdit" => path("notebook_path").map(|path| format!("Wants to edit {path}")),
        "Read" => path("file_path").map(|path| format!("Wants to read {path}")),
        "WebFetch" => field("url").map(|url| format!("Wants to fetch {url}")),
        "WebSearch" => field("query").map(|query| format!("Wants to search the web for {query}")),
        _ => None,
    };
    // Junie names its terminal tool otherwise, and says what it runs the same way.
    let said = said.or_else(|| field("command").map(|command| format!("Wants to run {command}")));
    said.unwrap_or_else(|| match tool.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
        Some((server, name)) => format!("Wants to use {name} from {server}"),
        None if !tool.is_empty() => format!("Wants to use {tool}"),
        None => "Wants your permission".to_string(),
    })
}

/// A tool call that is itself a question for the person, about to be put to
/// them: what it asks, with the answers offered, or the plan it wants
/// approved. `None` for any other, and for the hook after the same call,
/// which comes once it was answered and carries the same input.
pub fn asks(input: &Value) -> Option<String> {
    if input.get("hook_event_name").and_then(Value::as_str) != Some("PreToolUse") {
        return None;
    }
    match input.get("tool_name").and_then(Value::as_str)? {
        "AskUserQuestion" => {
            let questions = input.pointer("/tool_input/questions")?.as_array()?;
            let first = questions.first()?;
            let question = first.get("question").and_then(Value::as_str)?;
            let options: Vec<&str> = first
                .get("options")
                .and_then(Value::as_array)
                .map(|options| options.iter().filter_map(|o| o.get("label").and_then(Value::as_str)).collect())
                .unwrap_or_default();
            let mut text = format!("Asks: {question}");
            if !options.is_empty() {
                text.push_str(&format!(" ({})", options.join(" / ")));
            }
            if questions.len() > 1 {
                text.push_str(&format!(" and {} more", questions.len() - 1));
            }
            Some(text)
        }
        "ExitPlanMode" => {
            let plan = input.pointer("/tool_input/plan").and_then(Value::as_str).map(gist).unwrap_or_default();
            Some(if plan.is_empty() { "Has a plan for you to approve".to_string() } else { format!("Has a plan for you to approve: {plan}") })
        }
        _ => None,
    }
}

/// `path` from the session's directory when it is under it, which is how the
/// person knows it; as given otherwise.
fn relative(input: &Value, path: &str) -> String {
    let cwd = input.get("cwd").and_then(Value::as_str).unwrap_or_default().trim_end_matches('/');
    match path.strip_prefix(cwd).and_then(|rest| rest.strip_prefix('/')) {
        Some(rest) if !cwd.is_empty() && !rest.is_empty() => rest.to_string(),
        _ => path.to_string(),
    }
}

/// The first paragraph of a reply or a plan with its Markdown taken off: a
/// heading's hashes, emphasis, code ticks, a list's bullet. What a
/// notification can show of it in a line or two.
fn gist(text: &str) -> String {
    let paragraph = text
        .split("\n\n")
        .map(str::trim)
        .find(|part| part.chars().any(char::is_alphanumeric))
        .unwrap_or_default();
    paragraph
        .lines()
        .map(|line| line.trim_start().trim_start_matches(['#', '>', '-', '*', ' ']).trim())
        .collect::<Vec<_>>()
        .join(" ")
        .replace("**", "")
        .replace("__", "")
        .replace('`', "")
}

/// One line, at most [`NOTE_CHARS`], cut at a word with an ellipsis when it
/// is longer.
fn clip(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= NOTE_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(NOTE_CHARS - 1).collect();
    let cut = match cut.rfind(' ') {
        Some(space) if space > NOTE_CHARS / 2 => &cut[..space],
        _ => &cut,
    };
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.', ' ']))
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

/// Whether a hook is Claude Code's `Notification` of a permission prompt,
/// which comes seconds after the request or the question it is about and
/// says less than they did. Any other notification is news of its own: an
/// MCP server's question, an extension's prompt. Told by its type where
/// Claude Code sends one, and by its words where it does not.
pub fn echoes_a_prompt(input: &Value) -> bool {
    if input.get("hook_event_name").and_then(Value::as_str) != Some("Notification") {
        return false;
    }
    match input.get("notification_type").and_then(Value::as_str) {
        Some(kind) => kind == "permission_prompt",
        None => input.get("message").and_then(Value::as_str).is_some_and(|text| text.contains("needs your permission")),
    }
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
        assert_eq!(note(&bash), "Wants to run touch made.txt");
        let edit = json!({ "hook_event_name": "PermissionRequest", "tool_name": "Edit", "tool_input": {} });
        assert_eq!(note(&edit), "Wants to use Edit");
        assert_eq!(note(&json!({ "hook_event_name": "Stop" })), "");
    }

    #[test]
    fn says_what_claude_asks_permission_for() {
        let asked = |tool: &str, input: Value| {
            note(&json!({ "hook_event_name": "PermissionRequest", "cwd": "/repo", "tool_name": tool, "tool_input": input }))
        };
        assert_eq!(asked("Bash", json!({ "command": "npm test -- --run", "description": "Run tests" })), "Wants to run npm test -- --run");
        assert_eq!(asked("Edit", json!({ "file_path": "/repo/src/watch.rs", "old_string": "a" })), "Wants to edit src/watch.rs");
        assert_eq!(asked("Write", json!({ "file_path": "/elsewhere/x.md" })), "Wants to write /elsewhere/x.md");
        assert_eq!(asked("WebFetch", json!({ "url": "https://docs.rs/notify" })), "Wants to fetch https://docs.rs/notify");
        assert_eq!(asked("mcp__roer__show_ui", json!({})), "Wants to use show_ui from roer");
        assert_eq!(asked("Glob", json!({ "pattern": "*" })), "Wants to use Glob");
    }

    #[test]
    fn says_what_a_question_or_a_plan_asks() {
        let question = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [
                { "question": "Which base branch?", "header": "Base", "options": [{ "label": "main" }, { "label": "release" }], "multiSelect": false },
                { "question": "Squash?", "options": [] },
            ] },
        });
        assert_eq!(note(&question), "Asks: Which base branch? (main / release) and 1 more");
        let plan = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "ExitPlanMode",
            "tool_input": { "plan": "## Watch HEAD\n\nThen the **rest** of it." },
        });
        assert_eq!(note(&plan), "Has a plan for you to approve: Watch HEAD");
        assert!(asks(&plan).is_some() && asks(&question).is_some());
        // Any other tool call is only work, and says nothing.
        let bash = json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "ls" } });
        assert_eq!(asks(&bash), None);
        assert_eq!(note(&bash), "");
        // The hook after the question, once it was answered, with the same input: asks nothing.
        let mut answered = question.clone();
        answered["hook_event_name"] = json!("PostToolUse");
        assert_eq!(asks(&answered), None);
    }

    #[test]
    fn tells_an_echo_of_a_prompt_from_news() {
        let notification = |kind: Option<&str>, message: &str| {
            let mut input = json!({ "hook_event_name": "Notification", "message": message });
            if let Some(kind) = kind {
                input["notification_type"] = json!(kind);
            }
            input
        };
        assert!(echoes_a_prompt(&notification(Some("permission_prompt"), "Claude needs your permission to use Bash")));
        assert!(echoes_a_prompt(&notification(None, "Claude needs your permission to use Bash")));
        // An MCP server's question, or Pi's extension prompt, is a prompt of its own.
        assert!(!echoes_a_prompt(&notification(Some("elicitation_dialog"), "roer wants your input")));
        assert!(!echoes_a_prompt(&notification(None, "Asks: Which release?")));
        assert!(!echoes_a_prompt(&json!({ "hook_event_name": "PermissionRequest", "message": "needs your permission" })));
    }

    #[test]
    fn hands_pi_an_extension_that_runs_this_roer() {
        assert!(settings_path("pi").to_string_lossy().ends_with("pi-status.ts"));
        let text = PI_EXTENSION.replace("__ROER__", &Value::String("/Apps/My \"Roer\"/roer".into()).to_string());
        // The path as a JS string, whatever is in it.
        assert!(text.contains(r#"const ROER = "/Apps/My \"Roer\"/roer";"#), "{text}");
        for event in ["agent_start", "ui_prompt_start", "ui_prompt_end", "agent_end", "agent_settled", "session_shutdown"] {
            assert!(text.contains(&format!("pi.on(\"{event}\"")), "{event}");
        }
        // One `roer status` at a time, in the order the events came: side by side, a `working` could land after
        // the `done` that followed it.
        assert!(text.contains("queue = queue.then("), "{text}");
        // A stopped run's half a reply is no "Done:" note: told by the reply itself, since `agent_settled`
        // carries nothing to say so.
        assert!(text.contains(r#"message.stopReason === "aborted""#), "{text}");
        assert!(!text.contains("event?.aborted"), "{text}");
        // Shutdown waits for the clear, whose call it is handed.
        assert!(text.contains(r#"pi.on("session_shutdown", () => status("clear""#), "{text}");
        assert!(text.contains("return queue;"), "{text}");
        // Not the words Claude Code's idle reminder uses, which say nothing is asked.
        assert!(!text.contains("waiting for your input"));
        // Every string literal on one line: a line break in one is a syntax error, and Pi loads nothing.
        for line in text.lines() {
            assert_eq!(line.matches('"').count() % 2, 0, "{line}");
        }
    }

    #[test]
    fn says_what_a_turn_ended_on() {
        let stop = |text: &str| note(&json!({ "hook_event_name": "Stop", "last_assistant_message": text }));
        assert_eq!(stop("Opened **PR #140** against `main`.\n\n| a | b |\n"), "Opened PR #140 against main.");
        assert_eq!(stop("\n\n## Done\n\n- one\n- two"), "Done");
        let long = stop(&"word ".repeat(100));
        assert!(long.ends_with('…') && long.chars().count() <= NOTE_CHARS, "{long}");
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
        // Claude's too, which it would otherwise answer.
        let claude = settings("claude", "/bin/roer");
        assert_eq!(claude["hooks"]["PermissionRequest"][0]["hooks"][0]["async"], true);
        assert_eq!(claude["hooks"]["PreToolUse"][0]["hooks"][0]["async"].as_bool(), None);
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
