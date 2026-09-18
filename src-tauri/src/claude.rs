//! Past Claude Code conversations, read straight from Claude's own on-disk
//! store under `~/.claude` — never written to, only ever read.
//!
//! Claude Code keeps one `<sessionId>.jsonl` transcript per conversation
//! under `~/.claude/projects/<encoded-cwd>/`, and one
//! `~/.claude/sessions/<pid>.json` per process it's currently tracking. This
//! module scans the former (bounded head/tail reads, never a whole
//! transcript) to build a resumable list, and consults the latter so a
//! conversation a live `claude` process still owns elsewhere is not offered
//! twice.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// How much of the start of a transcript to scan for a title. Transcripts
/// can run to hundreds of MB; this is always a bounded read, never the whole
/// file.
const HEAD_BYTES: u64 = 8 * 1024;
/// How much of the end of a transcript to scan — a conversation's summary
/// (when Claude generates one) tends to land near the end.
const TAIL_BYTES: u64 = 16 * 1024;
/// Upper bound on how many threads a single call returns. Scope is already
/// narrow (known cwds only), so this just bounds the worst case.
const MAX_THREADS: usize = 30;
/// How much of a title to show before truncating.
const TITLE_CHARS: usize = 80;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeThread {
    pub id: String,
    pub cwd: String,
    pub title: String,
    /// Seconds since the epoch, taken from the transcript file's mtime.
    pub updated_at: u64,
}

fn claude_home() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude"),
    }
}

/// Mirrors Claude Code's own project-directory naming: every byte that
/// isn't ASCII alphanumeric becomes `-`.
fn encode_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Session ids a still-running `claude` process currently owns, per
/// `~/.claude/sessions/<pid>.json`. Best-effort: a missing/unreadable
/// registry means "nothing known to be live," never an error that blocks
/// resume.
fn live_session_ids(home: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(entries) = std::fs::read_dir(home.join("sessions")) else {
        return ids;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let pid = value.get("pid").and_then(Value::as_u64);
        let session_id = value.get("sessionId").and_then(Value::as_str);
        if let (Some(pid), Some(session_id)) = (pid, session_id) {
            if process_alive(pid) {
                ids.insert(session_id.to_string());
            }
        }
    }
    ids
}

fn process_alive(pid: u64) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string()])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Past Claude conversations across the given cwds, most recently updated
/// first. Scoped strictly to those cwds — never a scan of every Claude
/// project on the machine.
pub fn threads_for(cwds: &[String]) -> Vec<ClaudeThread> {
    threads_for_home(&claude_home(), cwds)
}

fn threads_for_home(home: &Path, cwds: &[String]) -> Vec<ClaudeThread> {
    let live = live_session_ids(home);
    let mut dirs_seen = HashSet::new();
    let mut threads = Vec::new();

    for cwd in cwds {
        let encoded = encode_project_path(cwd);
        if !dirs_seen.insert(encoded.clone()) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(home.join("projects").join(&encoded)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if live.contains(id) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let updated_at = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let title = title_for(&path).unwrap_or_else(|| id.to_string());
            threads.push(ClaudeThread {
                id: id.to_string(),
                cwd: cwd.clone(),
                title,
                updated_at,
            });
        }
    }

    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    threads.truncate(MAX_THREADS);
    threads
}

/// A bounded head+tail scan for a title, without ever reading the whole
/// transcript. Priority: a `summary` event's text, tail before head (a
/// summary tends to land near the end and is the most recently generated
/// one); then the first non-sidechain user message's text, head before tail.
fn title_for(path: &Path) -> Option<String> {
    let head = read_head(path, HEAD_BYTES);
    let tail = read_tail(path, TAIL_BYTES);

    summary_in(&tail)
        .or_else(|| summary_in(&head))
        .or_else(|| first_prompt_in(&head))
        .or_else(|| first_prompt_in(&tail))
        .map(|title| truncate(&title))
}

fn read_head(path: &Path, bytes: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buf = vec![0u8; bytes as usize];
    let read = file.read(&mut buf).unwrap_or(0);
    buf.truncate(read);
    String::from_utf8_lossy(&buf).into_owned()
}

fn read_tail(path: &Path, bytes: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return String::new();
    };
    let start = len.saturating_sub(bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn lines_of(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines().filter_map(|line| serde_json::from_str(line).ok())
}

fn summary_in(text: &str) -> Option<String> {
    lines_of(text).find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("summary") {
            return None;
        }
        event
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn first_prompt_in(text: &str) -> Option<String> {
    lines_of(text).find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("user") {
            return None;
        }
        if event.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        message_text(event.get("message")?.get("content")?)
    })
}

/// A message's `content` is either a plain string or a list of content
/// blocks; only the first text block is of interest for a title.
fn message_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    content.as_array()?.iter().find_map(|block| {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        block.get("text").and_then(Value::as_str).map(str::to_string)
    })
}

fn truncate(title: &str) -> String {
    let title = title.trim();
    if title.chars().count() <= TITLE_CHARS {
        return title.to_string();
    }
    let mut truncated: String = title.chars().take(TITLE_CHARS).collect();
    truncated.push('…');
    truncated
}

#[tauri::command]
pub fn roer_claude_threads(cwds: Vec<String>) -> Vec<ClaudeThread> {
    threads_for(&cwds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        std::env::temp_dir().join(format!(
            "roer-claude-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn write_transcript(home: &Path, cwd: &str, id: &str, lines: &[&str]) {
        let dir = home.join("projects").join(encode_project_path(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.jsonl")), lines.join("\n")).unwrap();
    }

    fn write_session(home: &Path, pid: u64, session_id: &str) {
        let dir = home.join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{pid}.json")),
            format!(r#"{{"pid":{pid},"sessionId":"{session_id}","cwd":"/tmp"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn encodes_a_real_project_path() {
        assert_eq!(
            encode_project_path("/Users/andrey.sokolov/IdeaProjects/roer"),
            "-Users-andrey-sokolov-IdeaProjects-roer"
        );
    }

    #[test]
    fn prefers_a_tail_summary_over_everything_else() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/x",
            "abc",
            &[
                r#"{"type":"user","message":{"content":"first prompt"}}"#,
                r#"{"type":"summary","summary":"the real title"}"#,
            ],
        );

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].title, "the real title");
        assert_eq!(threads[0].id, "abc");
        assert_eq!(threads[0].cwd, "/tmp/x");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn falls_back_to_the_first_non_sidechain_user_message() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/x",
            "abc",
            &[
                r#"{"type":"user","isSidechain":true,"message":{"content":"sub-agent turn"}}"#,
                r#"{"type":"user","message":{"content":[{"type":"text","text":"the real prompt"}]}}"#,
            ],
        );

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads[0].title, "the real prompt");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn falls_back_to_the_session_id_when_nothing_parses() {
        let home = temp_home();
        write_transcript(&home, "/tmp/x", "abc", &["not json at all"]);

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads[0].title, "abc");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn excludes_a_thread_a_live_process_still_owns() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/x",
            "abc",
            &[r#"{"type":"summary","summary":"still open"}"#],
        );
        write_session(&home, std::process::id() as u64, "abc");

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert!(threads.is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn includes_a_thread_whose_owning_process_is_dead() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/x",
            "abc",
            &[r#"{"type":"summary","summary":"long gone"}"#],
        );
        // An arbitrarily large pid that's essentially guaranteed not to
        // exist on any test runner.
        write_session(&home, 999_999_999, "abc");

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads.len(), 1);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_missing_project_directory_is_skipped_not_an_error() {
        let home = temp_home();
        let threads = threads_for_home(&home, &["/tmp/nope".to_string()]);
        assert!(threads.is_empty());
    }
}
