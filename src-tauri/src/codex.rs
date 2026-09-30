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

use crate::claude::{read_head, truncate, ClaudeThread};

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

pub fn threads_for(cwds: &[String]) -> Vec<ClaudeThread> {
    threads_for_home(&codex_home(), cwds)
}

fn threads_for_home(home: &Path, cwds: &[String]) -> Vec<ClaudeThread> {
    let names = thread_names(home);
    let mut threads = Vec::new();
    for path in newest_rollouts(&home.join("sessions")) {
        let head = read_head(&path, HEAD_BYTES);
        let Some(cwd) = string_field(&head, "cwd") else { continue };
        if !cwds.iter().any(|root| cwd == *root || cwd.starts_with(&format!("{root}/"))) {
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
        threads.push(ClaudeThread { id, agent: "codex".to_string(), cwd, title, updated_at });
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
        let text = text.trim();
        (!text.is_empty() && !text.starts_with('<') && !text.starts_with("# AGENTS.md")).then(|| text.to_string())
    })
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
}
