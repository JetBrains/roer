//! Past Pi conversations, read from Pi's own store — never written to.
//!
//! Pi keeps one `<time>_<id>.jsonl` per conversation under a folder per
//! working directory in `~/.pi/agent/sessions/`. Its first line is a
//! `session` event with the conversation's id, cwd and when it began; a
//! `session_info` event names it once it is named; and each prompt and reply
//! is a `message` event.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::claude::{holds, read_head, read_tail, truncate, ClaudeThread, Message};
use crate::live::{self, Table};

/// How much of the start of a conversation to read for its first prompt.
const HEAD_BYTES: u64 = 64 * 1024;
/// How much of the end to read for the name it was last given.
const TAIL_BYTES: u64 = 64 * 1024;

fn sessions_dir() -> PathBuf {
    let var = |name: &str| std::env::var(name).ok().filter(|dir| !dir.is_empty()).map(PathBuf::from);
    var("PI_CODING_AGENT_SESSION_DIR")
        .or_else(|| var("PI_CODING_AGENT_DIR").map(|dir| dir.join("sessions")))
        .unwrap_or_else(|| crate::roer::home().unwrap_or_default().join(".pi").join("agent").join("sessions"))
}

/// Past Pi conversations under `cwds`, but for those a Pi in one of Roer's
/// panes (`panes`, their processes) has open, which its live row stands
/// for: told from what each was started with and when, see
/// [`live::open_in`].
pub fn threads_for(cwds: &[String], panes: Option<&[u64]>, table: &Table) -> Vec<ClaudeThread> {
    let threads: Vec<ClaudeThread> = transcripts_for(cwds).into_iter().map(|(thread, _)| thread).collect();
    let Some(panes) = panes.filter(|panes| !panes.is_empty()) else {
        return threads;
    };
    let agents = table.get().in_panes(panes, |words| live::runs(words, "pi"));
    let open = live::open_in(&threads, &agents, resumed_with);
    threads.into_iter().filter(|thread| !open.contains(&thread.id)).collect()
}

/// The conversation `pi --session <id or file>` was started with.
fn resumed_with(args: &[String]) -> Option<String> {
    let given = live::flag_value(args, "--session").or_else(|| live::flag_value(args, "--session-id"))?;
    Some(id_of(Path::new(&given)).unwrap_or(given))
}

/// Every past Pi conversation under `cwds`, each with its transcript.
pub fn transcripts_for(cwds: &[String]) -> Vec<(ClaudeThread, PathBuf)> {
    sessions_in(&sessions_dir(), cwds)
}

/// The id at the end of `2026-10-06T00-37-55-099Z_<id>.jsonl`.
fn id_of(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let (_, id) = stem.rsplit_once('_')?;
    (!id.is_empty()).then(|| id.to_string())
}

fn sessions_in(dir: &Path, cwds: &[String]) -> Vec<(ClaudeThread, PathBuf)> {
    let mut threads = Vec::new();
    let folders = std::fs::read_dir(dir).map(|it| it.flatten().map(|e| e.path()).collect::<Vec<_>>()).unwrap_or_default();
    for folder in folders {
        let Ok(files) = std::fs::read_dir(&folder) else { continue };
        for path in files.flatten().map(|e| e.path()) {
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(thread) = thread_of(&path, cwds) {
                threads.push((thread, path));
            }
        }
    }
    threads
}

/// What one conversation's file says of it, when it is under `cwds` and
/// anything was said in it.
fn thread_of(path: &Path, cwds: &[String]) -> Option<ClaudeThread> {
    let head = read_head(path, HEAD_BYTES);
    let header: Value = serde_json::from_str(head.lines().next()?).ok()?;
    if header.get("type")?.as_str()? != "session" {
        return None;
    }
    let cwd = header.get("cwd")?.as_str()?.to_string();
    // By component, so `/work/roer2` is not under `/work/roer`.
    if !cwds.iter().any(|root| Path::new(&cwd).starts_with(root)) {
        return None;
    }
    let id = header.get("id").and_then(Value::as_str).map(str::to_string).or_else(|| id_of(path))?;
    let long = std::fs::metadata(path).is_ok_and(|m| m.len() > HEAD_BYTES);
    let tail = if long { read_tail(path, TAIL_BYTES) } else { String::new() };
    let title = name_in(&tail).or_else(|| name_in(&head)).or_else(|| first_prompt_in(&head))?;
    let updated_at = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    Some(ClaudeThread {
        id,
        agent: "pi".to_string(),
        cwd,
        title: truncate(&title),
        updated_at,
        branch: None,
        open_elsewhere: false,
        created_at: header.get("timestamp").and_then(Value::as_str).and_then(live::rfc3339_epoch),
    })
}

/// The latest name a `session_info` event in `text` gives.
fn name_in(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .filter(|line| line.contains(r#""type":"session_info""#))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|event| event.get("name")?.as_str().map(|name| name.trim().to_string()))
        .find(|name| !name.is_empty())
}

fn first_prompt_in(text: &str) -> Option<String> {
    text.lines()
        .filter_map(|line| message_in(line.as_bytes()))
        .find(|message| message.role == "user")
        .map(|message| message.text)
}

/// A prompt or a reply on one line: a `message` from the person or from Pi,
/// its text and not its thinking, tool calls or their results.
pub(crate) fn message_in(line: &[u8]) -> Option<Message> {
    if !holds(line, br#""type":"message""#) {
        return None;
    }
    let event: Value = serde_json::from_slice(line).ok()?;
    if event.get("type")?.as_str()? != "message" {
        return None;
    }
    let message = event.get("message")?;
    let role = message.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let content = message.get("content")?;
    let text = match content.as_str() {
        Some(text) => text.trim().to_string(),
        None => content
            .as_array()?
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(Message { role: role.to_string(), text, at: event.get("timestamp").and_then(Value::as_str).map(str::to_string) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("roer-pi-{}-{n}", std::process::id()))
    }

    fn session(cwd: &str, id: &str) -> String {
        serde_json::json!({"type": "session", "version": 3, "id": id, "timestamp": "2026-10-06T00:37:55.099Z", "cwd": cwd})
            .to_string()
    }

    fn said(role: &str, content: Value) -> String {
        serde_json::json!({
            "type": "message", "id": "m", "parentId": "p", "timestamp": "2026-10-06T00:38:00.000Z",
            "message": {"role": role, "content": content},
        })
        .to_string()
    }

    fn write(dir: &Path, cwd: &str, id: &str, lines: &[String]) -> PathBuf {
        let folder = dir.join(format!("--{}--", cwd.trim_start_matches('/').replace('/', "-")));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join(format!("2026-10-06T00-37-55-099Z_{id}.jsonl"));
        std::fs::write(&path, lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
        path
    }

    #[test]
    fn lists_a_conversation_under_a_directory_by_its_first_prompt() {
        let dir = temp_dir();
        let prompt = said("user", serde_json::json!([{"type": "text", "text": "rename the module"}]));
        write(&dir, "/work/roer/cli", "01a1", &[session("/work/roer/cli", "01a1"), prompt.clone()]);
        write(&dir, "/work/roer2", "01a2", &[session("/work/roer2", "01a2"), prompt]);

        let threads = sessions_in(&dir, &["/work/roer".to_string()]);
        assert_eq!(threads.len(), 1);
        let (thread, _) = &threads[0];
        assert_eq!((thread.id.as_str(), thread.agent.as_str(), thread.cwd.as_str()), ("01a1", "pi", "/work/roer/cli"));
        assert_eq!(thread.title, "rename the module");
        assert_eq!(thread.created_at, live::rfc3339_epoch("2026-10-06T00:37:55Z"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn takes_the_name_it_was_last_given() {
        let dir = temp_dir();
        let lines = [
            session("/w", "01a1"),
            said("user", serde_json::json!("hello")),
            r#"{"type":"session_info","id":"i","name":"first name"}"#.to_string(),
            r#"{"type":"session_info","id":"j","name":"Port the bridge"}"#.to_string(),
        ];
        write(&dir, "/w", "01a1", &lines);

        assert_eq!(sessions_in(&dir, &["/w".to_string()])[0].0.title, "Port the bridge");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn leaves_out_one_nothing_was_said_in() {
        let dir = temp_dir();
        write(&dir, "/w", "01a1", &[session("/w", "01a1")]);

        assert!(sessions_in(&dir, &["/w".to_string()]).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_prompts_and_replies_not_thinking_or_tools() {
        let reply = said(
            "assistant",
            serde_json::json!([
                {"type": "thinking", "thinking": "hmm"},
                {"type": "text", "text": "Done."},
                {"type": "toolCall", "name": "bash"},
            ]),
        );
        let message = message_in(reply.as_bytes()).unwrap();
        assert_eq!((message.role.as_str(), message.text.as_str()), ("assistant", "Done."));
        assert_eq!(message.at.as_deref(), Some("2026-10-06T00:38:00.000Z"));

        let tool = said("toolResult", serde_json::json!([{"type": "text", "text": "a listing"}]));
        assert!(message_in(tool.as_bytes()).is_none());
        let calls = said("assistant", serde_json::json!([{"type": "toolCall", "name": "bash"}]));
        assert!(message_in(calls.as_bytes()).is_none());
    }

    #[test]
    fn knows_what_it_was_resumed_with() {
        let args = |words: &[&str]| words.iter().map(|word| word.to_string()).collect::<Vec<_>>();
        assert_eq!(resumed_with(&args(&["node", "/bin/pi", "--session", "01a1"])).as_deref(), Some("01a1"));
        assert_eq!(
            resumed_with(&args(&["pi", "--session", "/s/--w--/2026-10-06T00-37-55-099Z_01a1.jsonl"])).as_deref(),
            Some("01a1")
        );
        assert_eq!(resumed_with(&args(&["pi"])), None);
    }
}
