//! Past Codex conversations, read from Codex's own store — never written to.
//!
//! Codex keeps one `rollout-<time>-<id>.jsonl` per conversation under
//! `~/.codex/sessions/YYYY/MM/DD/`, whose first line is a `session_meta`
//! event with the conversation's id and cwd, and names the ones it has
//! titled in `~/.codex/session_index.jsonl`. Only the newest days are
//! scanned, and only the head of each file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::claude::{holds, read_head, truncate, ClaudeThread, Message};
use crate::live::{self, Table};

/// A session_meta line carries Codex's whole system prompt, so the head read
/// is larger than Claude's.
const HEAD_BYTES: u64 = 64 * 1024;
/// How many transcripts to look at, newest first, before giving up on
/// finding more for these directories.
const MAX_FILES: usize = 400;

fn codex_home() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => crate::roer::home().unwrap_or_default().join(".codex"),
    }
}

/// Past Codex conversations under `cwds`, but for those a Codex in one of
/// Roer's panes (`panes`, their processes) has open, which its live row
/// stands for. Codex keeps no registry of what it has open, so that is told
/// from what each was started with and when: see [`live::open_in`].
pub fn threads_for(cwds: &[String], panes: Option<&[u64]>, table: &Table) -> Vec<ClaudeThread> {
    let threads: Vec<ClaudeThread> = transcripts_for(cwds).into_iter().map(|(thread, _)| thread).collect();
    let Some(panes) = panes.filter(|panes| !panes.is_empty()) else {
        return threads;
    };
    let agents = table.get().in_panes(panes, |words| live::runs(words, "codex"));
    let open = live::open_in(&threads, &agents, resumed_with);
    threads.into_iter().filter(|thread| !open.contains(&thread.id)).collect()
}

/// The conversation `codex resume <id>` was started with.
fn resumed_with(args: &[String]) -> Option<String> {
    let at = args.iter().position(|word| word == "resume")?;
    args.get(at + 1).filter(|id| !id.starts_with('-')).cloned()
}

/// Every past Codex conversation under `cwds`, each with its transcript.
pub fn transcripts_for(cwds: &[String]) -> Vec<(ClaudeThread, PathBuf)> {
    rollouts_in(&codex_home(), cwds)
}

#[cfg(test)]
fn threads_for_home(home: &Path, cwds: &[String]) -> Vec<ClaudeThread> {
    rollouts_in(home, cwds).into_iter().map(|(thread, _)| thread).collect()
}

fn rollouts_in(home: &Path, cwds: &[String]) -> Vec<(ClaudeThread, PathBuf)> {
    let names = thread_names(home);
    let mut threads = Vec::new();
    for path in newest_rollouts(&home.join("sessions")) {
        let head = read_head(&path, HEAD_BYTES);
        let Some(cwd) = string_field(&head, "cwd") else { continue };
        // By component, so `C:\work\repo\sub` is under `C:\work\repo`, `/`
        // holds everything, and `/work/roer2` is not under `/work/roer`.
        if !cwds.iter().any(|root| Path::new(&cwd).starts_with(root)) {
            continue;
        }
        let Some(id) = rollout_id(&path) else { continue };
        let updated_at = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        let title = names
            .get(&id)
            .cloned()
            .or_else(|| first_prompt_in(&head))
            .map_or_else(|| id.clone(), |title| truncate(&title));
        // The first event's, `session_meta`'s: when Codex began it.
        let created_at = string_field(&head, "timestamp").as_deref().and_then(live::rfc3339_epoch);
        let thread =
            ClaudeThread { id, agent: "codex".to_string(), cwd, title, updated_at, branch: None, open_elsewhere: false, created_at };
        threads.push((thread, path));
    }
    threads
}

/// Transcripts, newest day first, newest file first within a day.
fn newest_rollouts(sessions: &Path) -> Vec<PathBuf> {
    fn sorted_desc(dir: &Path) -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> =
            std::fs::read_dir(dir).map(|it| it.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        entries.sort();
        entries.reverse();
        entries
    }
    let mut files = Vec::new();
    for year in sorted_desc(sessions) {
        for month in sorted_desc(&year) {
            for day in sorted_desc(&month) {
                for file in sorted_desc(&day) {
                    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        files.push(file);
                        if files.len() >= MAX_FILES {
                            return files;
                        }
                    }
                }
            }
        }
    }
    files
}

/// The uuid at the end of `rollout-2026-09-25T14-30-33-<uuid>.jsonl`.
fn rollout_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    (id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') && id.matches('-').count() == 4).then(|| id.to_string())
}

fn thread_names(home: &Path) -> HashMap<String, String> {
    let raw = std::fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default();
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let name = entry.get("thread_name")?.as_str()?.trim().to_string();
            (!name.is_empty()).then_some((id, name))
        })
        .collect()
}

/// The first `"key":"…"` string in `text`, read without parsing the line it
/// is in: the head read can end partway through the first line.
fn string_field(text: &str, key: &str) -> Option<String> {
    let start = text.find(&format!("\"{key}\":\""))? + key.len() + 4;
    let rest = &text[start..];
    let mut escaped = false;
    for (i, c) in rest.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return serde_json::from_str(&format!("\"{}\"", &rest[..i])).ok();
        }
    }
    None
}

/// What the person first asked, skipping what Codex injects as user turns
/// itself: the AGENTS.md text and `<environment_context>`.
fn first_prompt_in(text: &str) -> Option<String> {
    text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).find_map(|event| {
        let payload = event.get("payload")?;
        let text = match payload.get("type")?.as_str()? {
            "user_message" => payload.get("message")?.as_str()?.to_string(),
            "message" if payload.get("role")?.as_str()? == "user" => payload
                .get("content")?
                .as_array()?
                .iter()
                .find_map(|block| block.get("text").and_then(Value::as_str))?
                .to_string(),
            _ => return None,
        };
        (!is_injected(&text)).then(|| text.trim().to_string())
    })
}

/// A prompt or a reply on one rollout line: a `message` the person or Codex
/// wrote, not what Codex adds as the person's turn itself (AGENTS.md, its
/// `<environment_context>`), its own instructions, or tool calls.
pub(crate) fn message_in(line: &[u8]) -> Option<Message> {
    if !holds(line, br#""type":"response_item""#) || !holds(line, br#""type":"message""#) {
        return None;
    }
    let event: Value = serde_json::from_slice(line).ok()?;
    let payload = event.get("payload")?;
    if payload.get("type")?.as_str()? != "message" {
        return None;
    }
    let role = payload.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let texts: Vec<&str> = payload
        .get("content")?
        .as_array()?
        .iter()
        .filter(|block| matches!(block.get("type").and_then(Value::as_str), Some("input_text" | "output_text")))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter(|text| role != "user" || !is_injected(text))
        .collect();
    if texts.is_empty() {
        return None;
    }
    Some(Message {
        role: role.to_string(),
        text: texts.join("\n"),
        at: event.get("timestamp").and_then(Value::as_str).map(str::to_string),
    })
}

/// What Codex puts in the person's turn itself.
fn is_injected(text: &str) -> bool {
    let text = text.trim();
    text.is_empty() || text.starts_with('<') || text.starts_with("# AGENTS.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("roer-codex-{}-{n}", std::process::id()))
    }

    const ID: &str = "01a0d88b-c489-77f3-b307-d56d2efc4a67";

    fn write_rollout(home: &Path, day: &str, id: &str, cwd: &str, prompt: &str) {
        let dir = home.join("sessions").join(day);
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            format!(r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","base_instructions":{{"text":"You are Codex"}}}}}}"#),
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}"##.to_string(),
            format!(r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"{prompt}"}}]}}}}"#),
        ];
        std::fs::write(dir.join(format!("rollout-2026-09-25T14-30-33-{id}.jsonl")), lines.join("\n")).unwrap();
    }

    #[test]
    fn finds_conversations_under_a_directory_titled_by_their_first_prompt() {
        let home = temp_home();
        write_rollout(&home, "2026/09/25", ID, "/work/roer/cli", "fix the build");
        write_rollout(&home, "2026/09/24", "01a0d88b-c489-77f3-b307-d56d2efc4a68", "/work/roer2", "elsewhere");
        let threads = threads_for_home(&home, &["/work/roer".to_string()]);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, ID);
        assert_eq!(threads[0].agent, "codex");
        assert_eq!(threads[0].cwd, "/work/roer/cli");
        assert_eq!(threads[0].title, "fix the build");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_root_directory_holds_every_conversation() {
        let home = temp_home();
        write_rollout(&home, "2026/09/25", ID, "/work/roer", "fix the build");
        assert_eq!(threads_for_home(&home, &["/".to_string()]).len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn prefers_the_name_codex_gave_the_thread() {
        let home = temp_home();
        write_rollout(&home, "2026/09/25", ID, "/work/roer", "fix the build");
        std::fs::write(home.join("session_index.jsonl"), format!(r#"{{"id":"{ID}","thread_name":"Build fix"}}"#)).unwrap();
        let threads = threads_for_home(&home, &["/work/roer".to_string()]);
        assert_eq!(threads[0].title, "Build fix");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn reads_the_cwd_from_a_first_line_cut_short() {
        assert_eq!(string_field(r#"{"payload":{"cwd":"/a \"b\"","base_instructions":{"text":"trunc"#, "cwd").as_deref(), Some("/a \"b\""));
    }
    #[test]
    fn reads_what_was_said_not_what_codex_adds() {
        let message = |role: &str, kind: &str, text: &str| {
            serde_json::json!({
                "timestamp": "2026-10-22T19:53:02.000Z", "type": "response_item",
                "payload": {"type": "message", "role": role, "content": [{"type": kind, "text": text}]},
            })
            .to_string()
        };
        let asked = message_in(message("user", "input_text", "Discuss Lord of the Rings").as_bytes()).unwrap();
        assert_eq!((asked.role.as_str(), asked.text.as_str()), ("user", "Discuss Lord of the Rings"));
        assert_eq!(asked.at.as_deref(), Some("2026-10-22T19:53:02.000Z"));
        let replied = message_in(message("assistant", "output_text", "Gladly.").as_bytes()).unwrap();
        assert_eq!((replied.role.as_str(), replied.text.as_str()), ("assistant", "Gladly."));

        assert!(message_in(message("user", "input_text", "# AGENTS.md instructions").as_bytes()).is_none());
        assert!(message_in(message("user", "input_text", "<environment_context>…").as_bytes()).is_none());
        assert!(message_in(message("developer", "input_text", "be terse").as_bytes()).is_none());
        let call = r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#;
        assert!(message_in(call.as_bytes()).is_none());
    }

    #[test]
    fn knows_when_it_began_and_what_it_was_resumed_with() {
        let home = temp_home();
        write_rollout(&home, "2026/09/25", ID, "/work/roer", "fix the build");
        let path = home.join("sessions/2026/09/25").join(format!("rollout-2026-09-25T14-30-33-{ID}.jsonl"));
        let raw = std::fs::read_to_string(&path).unwrap().replacen(r#"{"type":"session_meta""#, r#"{"timestamp":"2026-09-25T12:30:33.000Z","type":"session_meta""#, 1);
        std::fs::write(&path, raw).unwrap();
        let threads = threads_for_home(&home, &["/work/roer".to_string()]);
        assert_eq!(threads[0].created_at, crate::live::rfc3339_epoch("2026-09-25T12:30:33Z"));

        let args = |words: &[&str]| words.iter().map(|word| word.to_string()).collect::<Vec<_>>();
        assert_eq!(resumed_with(&args(&["codex", "resume", ID, "-a", "untrusted"])).as_deref(), Some(ID));
        assert_eq!(resumed_with(&args(&["codex", "resume", "--last"])), None);
        assert_eq!(resumed_with(&args(&["codex"])), None);

        std::fs::remove_dir_all(&home).ok();
    }
}
