//! Past Junie conversations, read from Junie's own store — never written to.
//!
//! Junie keeps a folder per conversation under `~/.junie/sessions/`: a
//! `summary.json` with its id, folder, name and times, and an `events.jsonl`
//! of what happened in it, the person's prompts and Junie's answers among
//! them. A running Junie says which conversation it has open in
//! `~/.junie/processes/<pid>-<id>-….json`, as Claude Code does in its own.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::claude::{holds, read_head, truncate, ClaudeThread, Message};
use crate::live::{Owner, Started, Table};

/// How much of the start of a conversation's events to read for its first
/// prompt, when it has no name.
const HEAD_BYTES: u64 = 64 * 1024;

fn junie_home() -> PathBuf {
    crate::roer::home().unwrap_or_default().join(".junie")
}

/// Past Junie conversations under `cwds`: those a Junie in one of Roer's
/// panes has open marked with that pane, as its live row stands for them;
/// those open in a Junie elsewhere marked so. `panes` are the panes' processes; `None`
/// when they are not known, and then any live one may be in one.
pub fn threads_for(cwds: &[String], panes: Option<&[u64]>, table: &Table) -> Vec<ClaudeThread> {
    let home = junie_home();
    threads_in(&home, cwds, panes, table)
}

fn threads_in(home: &Path, cwds: &[String], panes: Option<&[u64]>, table: &Table) -> Vec<ClaudeThread> {
    let live = live_sessions(home, panes, table);
    sessions_in(home, cwds)
        .into_iter()
        .map(|(thread, _)| thread)
        .map(|thread| match live.get(&thread.id) {
            Some(Owner::Pane(pane)) => ClaudeThread { pane: Some(*pane), ..thread },
            Some(Owner::Elsewhere) => ClaudeThread { open_elsewhere: true, ..thread },
            None => thread,
        })
        .collect()
}

/// Every past Junie conversation under `cwds`, each with its events.
pub fn transcripts_for(cwds: &[String]) -> Vec<(ClaudeThread, PathBuf)> {
    sessions_in(&junie_home(), cwds)
}

/// The conversations running Junies have open, and where each runs.
fn live_sessions(home: &Path, panes: Option<&[u64]>, table: &Table) -> HashMap<String, Owner> {
    let mut owners = HashMap::new();
    let Ok(entries) = std::fs::read_dir(home.join("processes")) else {
        return owners;
    };
    let panes: Option<HashSet<u64>> = panes.map(|panes| panes.iter().copied().collect());
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(value) = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
            continue;
        };
        let (Some(pid), Some(id)) = (value.get("pid").and_then(Value::as_u64), value.get("sessionId").and_then(Value::as_str)) else {
            continue;
        };
        let started = value.get("startedAt").and_then(Value::as_u64).map_or(Started::Unknown, Started::Millis);
        if let Some(owner) = table.get().owner(pid, started, panes.as_ref()) {
            owners.insert(id.to_string(), owner);
        }
    }
    owners
}

fn sessions_in(home: &Path, cwds: &[String]) -> Vec<(ClaudeThread, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(home.join("sessions")) else {
        return Vec::new();
    };
    entries.flatten().filter_map(|entry| thread_of(&entry.path(), cwds)).collect()
}

/// What one conversation's folder says of it, when it is under `cwds` and
/// anything was said in it.
fn thread_of(dir: &Path, cwds: &[String]) -> Option<(ClaudeThread, PathBuf)> {
    let summary: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("summary.json")).ok()?).ok()?;
    let cwd = summary.get("projectDir")?.as_str()?.to_string();
    // By component, so `/work/roer2` is not under `/work/roer`.
    if !cwds.iter().any(|root| Path::new(&cwd).starts_with(root)) {
        return None;
    }
    let id = summary.get("sessionId")?.as_str()?.to_string();
    let events = dir.join("events.jsonl");
    let named = summary.get("taskName").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty());
    let title = match named {
        Some(name) => name.to_string(),
        None => read_head(&events, HEAD_BYTES)
            .lines()
            .filter_map(|line| message_in(line.as_bytes()))
            .find(|message| message.role == "user")?
            .text,
    };
    let secs = |key: &str| summary.get(key).and_then(Value::as_u64).map(|ms| ms / 1000);
    let modified = std::fs::metadata(&events)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let thread = ClaudeThread {
        id,
        agent: "junie".to_string(),
        cwd,
        title: truncate(&title),
        updated_at: modified.or_else(|| secs("updatedAt")).unwrap_or(0),
        branch: None,
        open_elsewhere: false,
        gone: false,
        pane: None,
        created_at: secs("createdAt"),
    };
    Some((thread, events))
}

/// A prompt or an answer on one events line: what the person asked, and the
/// result Junie gave once it was done, not its steps along the way.
pub(crate) fn message_in(line: &[u8]) -> Option<Message> {
    let prompt = holds(line, br#""kind":"UserPromptEvent""#);
    if !prompt && !holds(line, br#""ResultBlockUpdatedEvent""#) {
        return None;
    }
    let event: Value = serde_json::from_slice(line).ok()?;
    let (role, text) = if prompt {
        let text = event.get("presentablePrompt").or_else(|| event.get("prompt"))?.as_str()?;
        ("user", text)
    } else {
        let wrapper = event.get("event")?;
        let result = wrapper.get("agentEvent")?;
        // Each result is written as it starts and again once it is done.
        if result.get("kind")?.as_str()? != "ResultBlockUpdatedEvent" || wrapper.get("state")?.as_str()? != "COMPLETED" {
            return None;
        }
        ("assistant", result.get("result")?.as_str()?)
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(Message { role: role.to_string(), text: text.to_string(), at: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("roer-junie-{}-{n}", std::process::id()))
    }

    fn prompt(text: &str) -> String {
        serde_json::json!({"kind": "UserPromptEvent", "requestId": "r", "prompt": text, "presentablePrompt": text, "timestampMs": 1})
            .to_string()
    }

    fn result(state: &str, text: &str) -> String {
        serde_json::json!({
            "kind": "SessionA2uxEvent",
            "event": {"state": state, "agentEvent": {"kind": "ResultBlockUpdatedEvent", "stepId": "s", "result": text}},
            "taskId": "t", "timestampMs": 2,
        })
        .to_string()
    }

    fn write(home: &Path, id: &str, cwd: &str, name: &str, events: &[String]) {
        let dir = home.join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let summary = serde_json::json!({
            "sessionId": id, "createdAt": 1_790_000_000_000u64, "updatedAt": 1_790_000_100_000u64,
            "projectDir": cwd, "taskName": name, "lifecycle": "COMPLETED",
        });
        std::fs::write(dir.join("summary.json"), summary.to_string()).unwrap();
        std::fs::write(dir.join("events.jsonl"), events.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
    }

    #[test]
    fn lists_a_conversation_under_a_directory_by_its_name() {
        let home = temp_home();
        write(&home, "session-261019-212850-qi4v", "/work/roer/cli", "Fix the flaky test", &[prompt("fix it")]);
        write(&home, "session-261019-212850-zzzz", "/work/roer2", "Elsewhere", &[prompt("hello")]);

        let threads = threads_in(&home, &["/work/roer".to_string()], Some(&[]), &Table::default());
        assert_eq!(threads.len(), 1);
        let thread = &threads[0];
        assert_eq!((thread.id.as_str(), thread.agent.as_str()), ("session-261019-212850-qi4v", "junie"));
        assert_eq!((thread.cwd.as_str(), thread.title.as_str()), ("/work/roer/cli", "Fix the flaky test"));
        assert_eq!(thread.created_at, Some(1_790_000_000));

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn falls_back_to_the_first_prompt_and_leaves_out_one_with_none() {
        let home = temp_home();
        write(&home, "session-a", "/w", " ", &[prompt("why does it hang")]);
        write(&home, "session-b", "/w", "", &[result("COMPLETED", "nothing asked")]);

        let threads = threads_in(&home, &["/w".to_string()], Some(&[]), &Table::default());
        assert_eq!(threads.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["why does it hang"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn reads_a_prompt_and_the_result_once_done() {
        let asked = message_in(prompt("add a test").as_bytes()).unwrap();
        assert_eq!((asked.role.as_str(), asked.text.as_str()), ("user", "add a test"));
        assert!(message_in(result("IN_PROGRESS", "Added it.").as_bytes()).is_none());
        let done = message_in(result("COMPLETED", "Added it.").as_bytes()).unwrap();
        assert_eq!((done.role.as_str(), done.text.as_str()), ("assistant", "Added it."));
        let status = r#"{"kind":"SessionA2uxEvent","event":{"state":"COMPLETED","agentEvent":{"kind":"AgentCurrentStatusUpdatedEvent"}}}"#;
        assert!(message_in(status.as_bytes()).is_none());
    }

    fn register(home: &Path, pid: u64, id: &str, started_at: u64) {
        let dir = home.join("processes");
        std::fs::create_dir_all(&dir).unwrap();
        let entry = serde_json::json!({"pid": pid, "sessionId": id, "projectPath": "/w", "startedAt": started_at});
        std::fs::write(dir.join(format!("{pid}-{id}-0.json")), entry.to_string()).unwrap();
    }

    /// When this test process started, as Junie's registry says it.
    #[cfg(unix)]
    fn my_start_ms() -> u64 {
        let out = crate::process::command("ps")
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .args(["-o", "lstart=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        crate::live::lstart_epoch(String::from_utf8_lossy(&out.stdout).trim()).unwrap() * 1000
    }

    /// This test process stands for a Junie in a Roer pane: the pane's
    /// process is its parent.
    #[cfg(unix)]
    #[test]
    fn one_open_in_a_roer_pane_or_elsewhere_is_marked_so() {
        let home = temp_home();
        write(&home, "session-a", "/w", "Open here", &[prompt("hi")]);
        // As Junie writes it: once it is up, seconds after it started.
        register(&home, u64::from(std::process::id()), "session-a", my_start_ms() + 5_000);

        let pane = u64::from(std::os::unix::process::parent_id());
        let here = threads_in(&home, &["/w".to_string()], Some(&[pane]), &Table::default());
        assert_eq!(here[0].pane, Some(pane));
        let elsewhere = threads_in(&home, &["/w".to_string()], Some(&[]), &Table::default());
        assert!(elsewhere[0].open_elsewhere);

        std::fs::remove_dir_all(&home).ok();
    }

    /// A registry file outlives its process, and its pid can be taken by
    /// another: it only counts while that pid started when it says.
    #[test]
    fn a_registry_entry_for_a_process_since_gone_is_not_open() {
        let home = temp_home();
        write(&home, "session-a", "/w", "Long gone", &[prompt("hi")]);
        register(&home, u64::from(std::process::id()), "session-a", 1000);

        let threads = threads_in(&home, &["/w".to_string()], Some(&[]), &Table::default());
        #[cfg(unix)]
        assert!(!threads[0].open_elsewhere);
        // Windows cannot say when a process started, nor who started whom,
        // so a live pid is taken for one in a pane, as with Claude Code.
        #[cfg(windows)]
        assert!(threads.is_empty());

        std::fs::remove_dir_all(&home).ok();
    }
}
