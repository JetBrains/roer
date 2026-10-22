//! Past Claude Code conversations, read straight from Claude's own on-disk
//! store under `~/.claude` — never written to, only ever read.
//!
//! Claude Code keeps one `<sessionId>.jsonl` transcript per conversation
//! under `~/.claude/projects/<encoded-cwd>/`, and one
//! `~/.claude/sessions/<pid>.json` per process it's currently tracking. This
//! module reads the former (bounded head/tail reads, never a whole
//! transcript, and each only again once it changes) to build a resumable
//! list, and consults the latter to tell which conversations a live `claude`
//! still has open: in a Roer pane, where its live row stands for it, or
//! somewhere else, where resuming it would make two writers of one file.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

/// How much of the start of a transcript to read. Claude Code 2.x opens one
/// with the queued prompt and its attachments (hooks, skills, CLAUDE.md), so
/// the first real prompt sits some 17 KB in, at times past 100 KB.
/// Transcripts can run to hundreds of MB; this is always a bounded read.
const HEAD_BYTES: u64 = 64 * 1024;
/// How much of the end to read: Claude re-appends a conversation's titles and
/// last prompt as it goes, so they stay near the end.
const TAIL_BYTES: u64 = 64 * 1024;
/// How much of a title to show before truncating.
const TITLE_CHARS: usize = 80;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeThread {
    pub id: String,
    /// The CLI whose conversation this is, and so which one resumes it.
    pub agent: String,
    pub cwd: String,
    pub title: String,
    /// Seconds since the epoch, taken from the transcript file's mtime.
    pub updated_at: u64,
    /// The branch the conversation was last on, as Claude recorded it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Owned by a `claude` process still running, in another terminal or
    /// window: resuming it here would make two writers of one transcript.
    pub open_elsewhere: bool,
}

fn claude_home() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => crate::roer::home().unwrap_or_default().join(".claude"),
    }
}

/// Mirrors Claude Code's own project-directory naming: every byte that
/// isn't ASCII alphanumeric becomes `-`.
fn encode_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Where a live `claude` has a conversation open.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Owner {
    /// In one of Roer's own panes, whose live row stands for it.
    Pane,
    /// Anywhere else: another terminal, an editor, another Roer.
    Elsewhere,
}

/// Session ids still-running `claude` processes own, per
/// `~/.claude/sessions/<pid>.json`, and where each runs. Best-effort: a
/// missing/unreadable registry means "nothing known to be live," never an
/// error that blocks resume. `panes` are the processes of Roer's own panes;
/// `None` when they are not known, an older shim's, which is any of them.
fn live_sessions(home: &Path, panes: Option<&[u64]>) -> HashMap<String, Owner> {
    let mut owners = HashMap::new();
    let Ok(entries) = std::fs::read_dir(home.join("sessions")) else {
        return owners;
    };
    let mut claimed = Vec::new();
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
        let started = value.get("procStart").and_then(Value::as_str).map(str::to_string);
        if let (Some(pid), Some(session_id)) = (pid, session_id) {
            claimed.push((pid, started, session_id.to_string()));
        }
    }
    if claimed.is_empty() {
        return owners;
    }
    let processes = Processes::read();
    let panes: Option<HashSet<u64>> = panes.map(|panes| panes.iter().copied().collect());
    for (pid, started, session_id) in claimed {
        if let Some(owner) = processes.owner(pid, started.as_deref(), panes.as_ref()) {
            owners.insert(session_id, owner);
        }
    }
    owners
}

/// The process table, read once per listing: who is alive, since when, and
/// who started whom, which is what says a `claude` runs in one of Roer's
/// panes.
#[cfg(not(windows))]
struct Processes {
    /// By pid: its parent, and when it started as `ps` and Claude Code's
    /// `procStart` both say it (`Mon Jan  5 09:30:00 2026`, in UTC).
    table: HashMap<u64, (u64, String)>,
}

#[cfg(not(windows))]
impl Processes {
    fn read() -> Self {
        let out = crate::process::command("ps")
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .args(["-A", "-o", "pid=,ppid=,lstart="])
            .output();
        let text = out.map(|out| String::from_utf8_lossy(&out.stdout).into_owned()).unwrap_or_default();
        let table = text
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse().ok()?;
                let parent = fields.next()?.parse().ok()?;
                Some((pid, (parent, fields.collect::<Vec<_>>().join(" "))))
            })
            .collect();
        Processes { table }
    }

    /// `None` once the process is gone, or its pid has gone to another
    /// process since the registry was written. A pane's process is its
    /// shell, or the agent itself, so the pane is found among the process's
    /// ancestors.
    fn owner(&self, pid: u64, started: Option<&str>, panes: Option<&HashSet<u64>>) -> Option<Owner> {
        let (_, since) = self.table.get(&pid)?;
        if started.is_some_and(|started| started.split_whitespace().collect::<Vec<_>>().join(" ") != *since) {
            return None;
        }
        let Some(panes) = panes else {
            return Some(Owner::Pane);
        };
        let mut at = pid;
        for _ in 0..64 {
            if panes.contains(&at) {
                return Some(Owner::Pane);
            }
            match self.table.get(&at) {
                Some(&(parent, _)) if parent != at && parent != 0 => at = parent,
                _ => break,
            }
        }
        Some(Owner::Elsewhere)
    }
}

/// Windows has no `ps`. `tasklist` filtered to one pid prints its row, or
/// an "INFO: No tasks" line — and exits 0 either way, so the answer is in
/// what it prints: the pid as a quoted CSV field. It says nothing of who
/// started whom, so a live conversation is taken for one in a pane, and left
/// to its live row, as before any could be told apart.
#[cfg(windows)]
struct Processes;

#[cfg(windows)]
impl Processes {
    fn read() -> Self {
        Processes
    }

    fn owner(&self, pid: u64, _started: Option<&str>, _panes: Option<&HashSet<u64>>) -> Option<Owner> {
        crate::process::command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
            .then_some(Owner::Pane)
    }
}

/// Past Claude conversations across the given cwds, most recently updated
/// first. Scoped to those cwds and their descendant directories — never a
/// scan of every Claude project on the machine. `panes` are the processes of
/// Roer's panes, so a conversation running in one is left to its live row.
pub fn threads_for(cwds: &[String], panes: Option<&[u64]>) -> Vec<ClaudeThread> {
    threads_in(&claude_home(), cwds, panes)
}

#[cfg(test)]
fn threads_for_home(home: &Path, cwds: &[String]) -> Vec<ClaudeThread> {
    threads_in(home, cwds, Some(&[]))
}

fn threads_in(home: &Path, cwds: &[String], panes: Option<&[u64]>) -> Vec<ClaudeThread> {
    let live = live_sessions(home, panes);
    transcripts_in(home, cwds, &live).into_iter().map(|(thread, _)| thread).collect()
}

/// [`threads_in`], each with the transcript it was read from. `live` says
/// which conversations a running `claude` has open, and where; a search or
/// a preview, which goes to every conversation whoever has it open, passes
/// none, and so never reads the process table.
fn transcripts_in(home: &Path, cwds: &[String], live: &HashMap<String, Owner>) -> Vec<(ClaudeThread, PathBuf)> {
    let mut dirs_seen = HashSet::new();
    let mut threads = Vec::new();
    // The folders read, and every transcript in them, which is what says
    // which cached titles are of transcripts since deleted.
    let mut dirs_read = HashSet::new();
    let mut present = HashSet::new();

    let Ok(project_dirs) = std::fs::read_dir(home.join("projects")) else {
        return threads;
    };
    let project_dirs: Vec<PathBuf> = project_dirs.flatten().map(|e| e.path()).collect();

    for cwd in cwds {
        let encoded = encode_project_path(cwd);
        let descendant_prefix = format!("{encoded}-");

        for dir in &project_dirs {
            let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Encoding maps every byte one-for-one to itself or `-`, so a
            // path's encoded form is always a prefix of any descendant's —
            // the trailing `-` is what tells "under this root" apart from
            // an unrelated sibling that merely shares a string prefix (e.g.
            // `/tmp/one` from `/tmp/one2`).
            let is_root = name == encoded;
            if !is_root && !name.starts_with(&descendant_prefix) {
                continue;
            }
            if !dirs_seen.insert(name.to_string()) {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            dirs_read.insert(dir.clone());
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                present.insert(path.clone());
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let owner = live.get(id).copied();
                if owner == Some(Owner::Pane) {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                let meta = meta_cached(&path);
                // Agent SDK and `claude -p` runs: a pipeline's, not a
                // conversation anyone would come back to. Nor one with no
                // title at all, which nobody typed a word into: Claude
                // opened and quit, or used only for slash commands.
                if meta.automated {
                    continue;
                }
                let Some(title) = meta.title else {
                    continue;
                };
                // The exact root's own cwd is the one asked for; a
                // descendant directory's actual cwd has to come from the
                // transcript itself, since the encoding cannot be reversed.
                let actual_cwd = if is_root {
                    cwd.clone()
                } else {
                    match meta.cwd {
                        Some(found) => found,
                        None => continue,
                    }
                };
                let updated_at = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let thread = ClaudeThread {
                    id: id.to_string(),
                    agent: "claude".to_string(),
                    cwd: actual_cwd,
                    title,
                    updated_at,
                    branch: meta.branch,
                    open_elsewhere: owner == Some(Owner::Elsewhere),
                };
                threads.push((thread, path));
            }
        }
    }

    // A deleted transcript's title would otherwise be held on to for as long
    // as the app runs. Only in the folders read: another listing's are its own.
    lock(META.get_or_init(Default::default))
        .retain(|path, _| present.contains(path) || !path.parent().is_some_and(|dir| dirs_read.contains(dir)));
    threads.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));
    threads
}

/// What a transcript says about itself, from its head and tail.
#[derive(Clone, Debug, Default, PartialEq)]
struct Meta {
    title: Option<String>,
    cwd: Option<String>,
    branch: Option<String>,
    /// Written by the Agent SDK or `claude -p`, not by someone at a prompt.
    automated: bool,
}

/// Each transcript's [`Meta`], by path, with the size and time it was read
/// at. A refresh comes with every change on the stage, and reading a project's
/// hundreds of transcripts every time would be hundreds of MB.
static META: OnceLock<Mutex<HashMap<PathBuf, (u64, SystemTime, Meta)>>> = OnceLock::new();

/// [`meta_of`], read again only once the file's size or time has moved.
fn meta_cached(path: &Path) -> Meta {
    let Ok(stat) = std::fs::metadata(path) else {
        return Meta::default();
    };
    let (len, modified) = (stat.len(), stat.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    let cache = META.get_or_init(Default::default);
    if let Some((was_len, was_modified, meta)) = lock(cache).get(path) {
        if *was_len == len && *was_modified == modified {
            return meta.clone();
        }
    }
    let meta = meta_of(path);
    lock(cache).insert(path.to_path_buf(), (len, modified, meta.clone()));
    meta
}

fn meta_of(path: &Path) -> Meta {
    let head = scan(&read_head(path, HEAD_BYTES));
    let long = std::fs::metadata(path).is_ok_and(|m| m.len() > HEAD_BYTES);
    let tail = if long { scan(&read_tail(path, TAIL_BYTES)) } else { Scan::default() };
    Meta::from(head, tail)
}

impl Meta {
    /// A title, first found: the one the person gave it (`/rename`), the one
    /// Claude gave it, an older Claude's summary, its first real prompt, its
    /// last one. The latest of each, from the tail, before the head's.
    fn from(head: Scan, tail: Scan) -> Meta {
        let title = tail
            .custom_title
            .or(head.custom_title)
            .or(tail.ai_title)
            .or(head.ai_title)
            .or(tail.summary)
            .or(head.summary)
            .or(head.first_prompt)
            .or(tail.first_prompt)
            .or(tail.last_prompt)
            .or(head.last_prompt)
            .map(|title| truncate(&title));
        Meta {
            title,
            cwd: head.cwd.or(tail.cwd),
            // A detached checkout records `HEAD`, which names nothing.
            branch: tail.branch.or(head.branch).filter(|branch| branch != "HEAD"),
            automated: head.entrypoint.or(tail.entrypoint).is_some_and(|e| e.starts_with("sdk")),
        }
    }
}

/// One read's worth of what [`Meta`] is made from.
#[derive(Default)]
struct Scan {
    custom_title: Option<String>,
    ai_title: Option<String>,
    summary: Option<String>,
    first_prompt: Option<String>,
    last_prompt: Option<String>,
    cwd: Option<String>,
    branch: Option<String>,
    entrypoint: Option<String>,
}

/// One pass over the events in `text`: the first of what is set once, the
/// last of what Claude writes again as it changes.
fn scan(text: &str) -> Scan {
    let mut found = Scan::default();
    for event in lines_of(text) {
        let text_of = |key: &str| {
            event
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_string)
        };
        match event.get("type").and_then(Value::as_str) {
            Some("custom-title") => found.custom_title = text_of("customTitle").or(found.custom_title),
            Some("ai-title") => found.ai_title = text_of("aiTitle").or(found.ai_title),
            Some("summary") => found.summary = found.summary.or_else(|| text_of("summary")),
            Some("last-prompt") => found.last_prompt = text_of("lastPrompt").or(found.last_prompt),
            Some("user") => found.first_prompt = found.first_prompt.or_else(|| prompt_of(&event)),
            _ => {}
        }
        found.cwd = found.cwd.or_else(|| text_of("cwd"));
        found.branch = text_of("gitBranch").or(found.branch);
        found.entrypoint = found.entrypoint.or_else(|| text_of("entrypoint"));
    }
    found
}

pub(crate) fn read_head(path: &Path, bytes: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buf = Vec::with_capacity(bytes as usize);
    if file.by_ref().take(bytes).read_to_end(&mut buf).is_err() {
        return String::new();
    }
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

/// What the person typed, from a `user` event: not a sub-agent's turn, not
/// what Claude Code adds itself, and not a slash command or its output.
fn prompt_of(event: &Value) -> Option<String> {
    let flag = |key: &str| event.get(key).and_then(Value::as_bool) == Some(true);
    if flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") {
        return None;
    }
    let text = message_text(event.get("message")?.get("content")?)?;
    (!is_wrapper(&text)).then_some(text)
}

/// The text Claude Code itself puts in a `user` event: a slash command and
/// what it printed, a background task's notice, a hook's, an interruption.
fn is_wrapper(text: &str) -> bool {
    const WRAPPERS: [&str; 8] = [
        "<command-",
        "<local-command-",
        "<task-notification",
        "<bash-",
        "<system-reminder",
        "<user-prompt-submit-hook",
        "Caveat:",
        "[Request interrupted",
    ];
    let text = text.trim_start();
    text.is_empty() || WRAPPERS.iter().any(|wrapper| text.starts_with(wrapper))
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

pub(crate) fn truncate(title: &str) -> String {
    let title = title.trim();
    if title.chars().count() <= TITLE_CHARS {
        return title.to_string();
    }
    let mut truncated: String = title.chars().take(TITLE_CHARS).collect();
    truncated.push('…');
    truncated
}

/// Every resumable conversation under `cwds`: Claude Code's and Codex's,
/// most recently updated first. `panes` are the processes of Roer's own
/// panes (`roer list`'s `pid`); absent from an older frontend, or one whose
/// shim does not say them, and then any live conversation may be in one.
#[tauri::command(async)]
pub fn roer_claude_threads(cwds: Vec<String>, panes: Option<Vec<u64>>) -> Vec<ClaudeThread> {
    let mut threads = threads_for(&cwds, panes.as_deref());
    threads.extend(crate::codex::threads_for(&cwds));
    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    threads
}

/// A conversation a search found, and the words of it that matched, when
/// they were in what was said rather than in its name or place.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// How much text to show either side of a match.
const SNIPPET_CHARS: usize = 50;
/// How much of a transcript's start is kept to tell it is still the file it
/// was: one only ever grows, and one written anew starts differently.
const START_BYTES: u64 = 256;

/// What a transcript's conversation says, as far as it has been read: the
/// prompts and replies, not tool output, one message to a line.
#[derive(Default)]
struct Indexed {
    /// How far into the file it has been read, always to a line's end.
    parsed_to: u64,
    /// The file's first bytes, as they were when it was read.
    start: Vec<u8>,
    text: String,
    /// `text` through [`fold`], char for char.
    folded: String,
    /// Each message in `text`, in order, which is what a preview reads.
    messages: Vec<Said>,
}

/// One message of [`Indexed::text`]: who said it, when, and where it ends.
struct Said {
    role: String,
    at: Option<String>,
    /// The byte its text starts at, and the one past its end.
    span: (usize, usize),
}

/// Every transcript the last search looked in, each behind a lock of its
/// own: one read for the first time, which can take a while, holds up only
/// the searches that need that one.
#[derive(Default)]
struct TextIndex {
    entries: Mutex<HashMap<PathBuf, Arc<Mutex<Indexed>>>>,
}

impl TextIndex {
    fn entry(&self, path: &Path) -> Arc<Mutex<Indexed>> {
        lock(&self.entries).entry(path.to_path_buf()).or_default().clone()
    }

    /// Forgets every transcript but these: one deleted, or no longer in
    /// view, would otherwise be held on to for as long as the app runs.
    fn keep_only(&self, paths: &HashSet<&Path>) {
        lock(&self.entries).retain(|path, _| paths.contains(path.as_path()));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock(&self.entries).len()
    }
}

static TEXT: OnceLock<TextIndex> = OnceLock::new();

/// A lock, even one a panicking search left poisoned: what it guards is a
/// cache, at worst a stale one, not a reason to stop searching for good.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Lower case, one char for one, so an offset into the folded text counts
/// the same chars as in the text itself.
fn fold(text: &str) -> String {
    text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

/// Reads whatever was appended to `path` since it was last read, a line at
/// a time: a transcript can run to hundreds of MB, most of it tool output.
fn read_appended(entry: &mut Indexed, path: &Path) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut start = Vec::new();
    if file.by_ref().take(START_BYTES).read_to_end(&mut start).is_err() {
        return;
    }
    if len < entry.parsed_to || !start.starts_with(&entry.start) {
        // Written anew, not appended to: start over.
        *entry = Indexed::default();
    }
    entry.start = start;
    if len == entry.parsed_to || file.seek(SeekFrom::Start(entry.parsed_to)).is_err() {
        return;
    }
    let mut reader = std::io::BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        if !matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
            break;
        }
        // A line still being written is left for the next search.
        if line.last() != Some(&b'\n') {
            break;
        }
        if let Some(message) = message_in(&line[..line.len() - 1]) {
            let from = entry.text.len();
            entry.text.push_str(&message.text);
            entry.messages.push(Said { role: message.role, at: message.at, span: (from, entry.text.len()) });
            entry.text.push('\n');
            entry.folded.push_str(&fold(&message.text));
            entry.folded.push('\n');
        }
        entry.parsed_to += line.len() as u64;
    }
}

/// The words of a prompt or a reply on one transcript line, with who said
/// it and when; `None` for everything else: tool calls and their output, and
/// what Claude Code writes in a prompt's place itself.
fn message_in(line: &[u8]) -> Option<Message> {
    // Far cheaper than parsing every line, most of which are neither.
    let is = |needle: &[u8]| line.windows(needle.len()).any(|window| window == needle);
    if !is(br#""type":"user""#) && !is(br#""type":"assistant""#) {
        return None;
    }
    // Most of a transcript's bytes are tool calls and their output, which are
    // `user` and `assistant` events too: one with no text block says nothing.
    // Inside a string the quotes would be escaped, so this is only ever a
    // block's own `type`.
    if (is(br#""type":"tool_result""#) || is(br#""type":"tool_use""#)) && !is(br#""type":"text""#) {
        return None;
    }
    let event: Value = serde_json::from_slice(line).ok()?;
    let kind = event.get("type").and_then(Value::as_str)?;
    let flag = |key: &str| event.get(key).and_then(Value::as_bool) == Some(true);
    if (kind != "user" && kind != "assistant") || flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") {
        return None;
    }
    let said = |text: &&str| kind != "user" || !is_wrapper(text);
    let content = event.get("message")?.get("content")?;
    let text = if let Some(text) = content.as_str() {
        said(&text).then(|| text.to_string())?
    } else {
        let texts: Vec<&str> = content
            .as_array()?
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .filter(said)
            .collect();
        if texts.is_empty() {
            return None;
        }
        texts.join("\n")
    };
    Some(Message {
        role: kind.to_string(),
        text,
        at: event.get("timestamp").and_then(Value::as_str).map(str::to_string),
    })
}

/// How many of a conversation's latest messages a preview shows.
const PREVIEW_MESSAGES: usize = 200;
/// How much of one message a preview shows: a reply can be a whole file.
const PREVIEW_CHARS: usize = 4000;

/// One prompt or reply, as a preview shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// `user` or `assistant`.
    pub role: String,
    pub text: String,
    /// When it was said, as Claude recorded it (RFC 3339).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// What a conversation said, to read without resuming it: resuming starts
/// `claude`, and with it its hooks and MCP servers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// The latest of its prompts and replies, oldest first.
    pub messages: Vec<Message>,
    /// How many before those were left out.
    pub earlier: usize,
}

#[cfg(test)]
fn transcript_in(home: &Path, cwds: &[String], id: &str) -> Option<Transcript> {
    transcript_from(home, cwds, id, &TextIndex::default())
}

/// Read through the same index a search reads, so stepping from row to row
/// reads each transcript once, and after that only what was added to it.
fn transcript_from(home: &Path, cwds: &[String], id: &str, index: &TextIndex) -> Option<Transcript> {
    let (_, path) = transcripts_in(home, cwds, &HashMap::new()).into_iter().find(|(thread, _)| thread.id == id)?;
    let entry = index.entry(&path);
    let mut indexed = lock(&entry);
    read_appended(&mut indexed, &path);
    let earlier = indexed.messages.len().saturating_sub(PREVIEW_MESSAGES);
    let messages = indexed.messages[earlier..]
        .iter()
        .map(|said| {
            let text = &indexed.text[said.span.0..said.span.1];
            let text = match text.char_indices().nth(PREVIEW_CHARS) {
                Some((cut, _)) => format!("{}…", &text[..cut]),
                None => text.to_string(),
            };
            Message { role: said.role.clone(), text, at: said.at.clone() }
        })
        .collect();
    Some(Transcript { messages, earlier })
}

/// A past Claude conversation's prompts and replies, read from its
/// transcript and nothing else: no `claude` is started to show them.
/// `None` when it is not among those under `cwds`.
#[tauri::command(async)]
pub fn roer_claude_transcript(cwds: Vec<String>, id: String) -> Option<Transcript> {
    transcript_from(&claude_home(), &cwds, &id, TEXT.get_or_init(TextIndex::default))
}

/// The text around the first of `terms` it holds, on one line.
fn snippet(indexed: &Indexed, terms: &[String]) -> Option<String> {
    let (at, term) = terms
        .iter()
        .filter_map(|term| indexed.folded.find(term.as_str()).map(|at| (at, term)))
        .min_by_key(|(at, _)| *at)?;
    // In chars, which the text and its folded form count alike.
    let first = indexed.folded[..at].chars().count();
    let from = first.saturating_sub(SNIPPET_CHARS);
    let to = first + term.chars().count() + SNIPPET_CHARS;
    let text = &indexed.text;
    let byte = |nth: usize| text.char_indices().nth(nth).map_or(text.len(), |(at, _)| at);
    let (start, end) = (byte(from), byte(to));
    let words = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    let before = if start > 0 { "…" } else { "" };
    let after = if end < text.len() { "…" } else { "" };
    Some(format!("{before}{words}{after}"))
}

/// The conversations under `cwds` in which every word of `query` appears,
/// whatever its case: in the name, the folder (so a worktree's), the branch,
/// or what was said.
pub fn search(cwds: &[String], query: &str) -> Vec<SearchHit> {
    search_in(&claude_home(), cwds, query, TEXT.get_or_init(TextIndex::default))
}

fn search_in(home: &Path, cwds: &[String], query: &str, index: &TextIndex) -> Vec<SearchHit> {
    let terms: Vec<String> = fold(query).split_whitespace().map(str::to_string).collect();
    if terms.is_empty() {
        return Vec::new();
    }
    // Every conversation, whoever has it open: a search finds, the list
    // decides what to show.
    let transcripts = transcripts_in(home, cwds, &HashMap::new());
    let mut hits = Vec::new();
    for (thread, path) in &transcripts {
        let place = fold(&format!("{}\n{}\n{}", thread.title, thread.cwd, thread.branch.as_deref().unwrap_or("")));
        let entry = index.entry(path);
        let mut indexed = lock(&entry);
        read_appended(&mut indexed, path);
        if !terms.iter().all(|term| place.contains(term.as_str()) || indexed.folded.contains(term.as_str())) {
            continue;
        }
        hits.push(SearchHit { id: thread.id.clone(), snippet: snippet(&indexed, &terms) });
    }
    index.keep_only(&transcripts.iter().map(|(_, path)| path.as_path()).collect());
    hits
}

/// [`search`] over Claude Code's conversations, and Codex's by their names
/// and folders.
#[tauri::command(async)]
pub fn roer_claude_search(cwds: Vec<String>, query: String) -> Vec<SearchHit> {
    let mut hits = search(&cwds, &query);
    let terms: Vec<String> = fold(&query).split_whitespace().map(str::to_string).collect();
    hits.extend(
        crate::codex::threads_for(&cwds)
            .into_iter()
            .filter(|thread| {
                let place = fold(&format!("{}\n{}", thread.title, thread.cwd));
                !terms.is_empty() && terms.iter().all(|term| place.contains(term.as_str()))
            })
            .map(|thread| SearchHit { id: thread.id, snippet: None }),
    );
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A directory of this test's own. Not just a timestamp: tests run in
    /// parallel threads of the same process, so two calls close enough
    /// together can otherwise land on the same nanosecond and collide.
    fn temp_home() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("roer-claude-{}-{n}", std::process::id()))
    }

    fn write_transcript(home: &Path, cwd: &str, id: &str, lines: &[&str]) {
        let dir = home.join("projects").join(encode_project_path(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        // Each line ends with a newline, as Claude Code writes them.
        std::fs::write(dir.join(format!("{id}.jsonl")), lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
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

    /// A transcript laid out as Claude Code 2.x writes one: a queued prompt
    /// and attachments (hooks, skills, CLAUDE.md) pushing the first real
    /// `user` event well past the first 8 KB, `lines` after them.
    fn current_transcript(cwd: &str, lines: &[String]) -> Vec<String> {
        let filler = "x".repeat(5000);
        let mut all = vec![
            format!(r#"{{"type":"queue-operation","operation":"enqueue","content":"{filler}"}}"#),
            r#"{"type":"queue-operation","operation":"dequeue"}"#.to_string(),
        ];
        for _ in 0..3 {
            all.push(format!(r#"{{"type":"attachment","attachment":{{"content":"{filler}"}}}}"#));
        }
        all.extend(lines.iter().map(|line| line.replace("$CWD", cwd)));
        all
    }

    fn write_lines(home: &Path, cwd: &str, id: &str, lines: &[String]) {
        let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_transcript(home, cwd, id, &lines);
    }

    fn user(text: &str) -> String {
        serde_json::json!({
            "type": "user", "cwd": "$CWD", "entrypoint": "cli", "gitBranch": "main",
            "message": {"role": "user", "content": text},
        })
        .to_string()
    }

    fn assistant(text: &str) -> String {
        serde_json::json!({
            "type": "assistant", "cwd": "$CWD",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
        })
        .to_string()
    }

    fn title_of(home: &Path, cwd: &str) -> String {
        let threads = threads_for_home(home, &[cwd.to_string()]);
        assert_eq!(threads.len(), 1, "{threads:?}");
        threads[0].title.clone()
    }

    #[test]
    fn finds_the_first_prompt_past_the_attachments() {
        let home = temp_home();
        // A long reply after it, as there always is, keeps it out of the tail.
        let lines = current_transcript("/tmp/x", &[user("fix the flaky test"), assistant(&"y".repeat(20_000))]);
        write_lines(&home, "/tmp/x", "abc", &lines);

        assert_eq!(title_of(&home, "/tmp/x"), "fix the flaky test");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn takes_the_ai_title() {
        let home = temp_home();
        let lines = current_transcript(
            "/tmp/x",
            &[user("hey! look at this"), r#"{"type":"ai-title","aiTitle":"Login form loses focus"}"#.to_string()],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        assert_eq!(title_of(&home, "/tmp/x"), "Login form loses focus");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_custom_title_beats_the_ai_title() {
        let home = temp_home();
        let lines = current_transcript(
            "/tmp/x",
            &[
                r#"{"type":"custom-title","customTitle":"old name"}"#.to_string(),
                user("hey! look at this"),
                r#"{"type":"ai-title","aiTitle":"Login form loses focus"}"#.to_string(),
                r#"{"type":"custom-title","customTitle":"auth-refactor"}"#.to_string(),
            ],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        assert_eq!(title_of(&home, "/tmp/x"), "auth-refactor");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn skips_wrapper_text_for_the_first_prompt() {
        let home = temp_home();
        let meta = serde_json::json!({
            "type": "user", "isMeta": true, "message": {"content": "Caveat: The messages below were generated by the user"},
        })
        .to_string();
        let lines = current_transcript(
            "/tmp/x",
            &[
                meta,
                user("<command-name>/model</command-name>\n<command-message>model</command-message>"),
                user("<local-command-stdout>Set model to opus</local-command-stdout>"),
                user("<task-notification> <task-id>t1</task-id> </task-notification>"),
                user("  "),
                user("Why does the build fail on CI"),
            ],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        assert_eq!(title_of(&home, "/tmp/x"), "Why does the build fail on CI");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn falls_back_to_the_last_prompt() {
        let home = temp_home();
        let lines = current_transcript(
            "/tmp/x",
            &[r#"{"type":"last-prompt","lastPrompt":"run the tests again"}"#.to_string()],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        assert_eq!(title_of(&home, "/tmp/x"), "run the tests again");

        std::fs::remove_dir_all(&home).ok();
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

    /// Claude opened and quit, or used only for slash commands: nothing was
    /// said that resuming would continue.
    #[test]
    fn leaves_out_a_session_nobody_said_anything_in() {
        let home = temp_home();
        write_transcript(&home, "/tmp/x", "garbled", &["not json at all"]);
        write_lines(&home, "/tmp/x", "opened", &current_transcript("/tmp/x", &[r#"{"type":"system","content":"hi"}"#.to_string()]));
        let commands = current_transcript(
            "/tmp/x",
            &[user("<command-name>/clear</command-name>"), user("<local-command-stdout>done</local-command-stdout>")],
        );
        write_lines(&home, "/tmp/x", "commands", &commands);

        assert!(threads_for_home(&home, &["/tmp/x".to_string()]).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    /// Only where who started whom can be told apart: see `Processes`.
    #[cfg(unix)]
    #[test]
    fn lists_a_thread_a_live_process_still_owns_marked() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/x",
            "abc",
            &[r#"{"type":"summary","summary":"still open"}"#],
        );
        write_session(&home, std::process::id() as u64, "abc");

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads.len(), 1);
        assert!(threads[0].open_elsewhere);

        std::fs::remove_dir_all(&home).ok();
    }

    /// This test process stands for a `claude` in a Roer pane: the pane's
    /// process is its parent.
    #[cfg(unix)]
    #[test]
    fn a_thread_open_in_a_roer_pane_is_left_to_its_live_row() {
        let home = temp_home();
        write_transcript(&home, "/tmp/x", "abc", &[r#"{"type":"summary","summary":"in a pane"}"#]);
        write_session(&home, std::process::id() as u64, "abc");

        let pane = std::os::unix::process::parent_id() as u64;
        assert!(threads_in(&home, &["/tmp/x".to_string()], Some(&[pane])).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    /// An older shim says nothing of its panes' processes, so any live
    /// conversation could be in one: left to its live row, as before.
    #[test]
    fn without_knowing_the_panes_a_live_thread_is_left_to_its_row() {
        let home = temp_home();
        write_transcript(&home, "/tmp/x", "abc", &[r#"{"type":"summary","summary":"somewhere"}"#]);
        write_session(&home, std::process::id() as u64, "abc");

        assert!(threads_in(&home, &["/tmp/x".to_string()], None).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    /// A registry file outlives its process, and the pid in it can be taken
    /// by another: it only counts while that pid started when it says.
    #[cfg(unix)]
    #[test]
    fn a_pid_taken_by_another_process_is_not_the_conversation_open() {
        let home = temp_home();
        write_transcript(&home, "/tmp/x", "abc", &[r#"{"type":"summary","summary":"long gone"}"#]);
        let dir = home.join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let pid = std::process::id();
        std::fs::write(
            dir.join(format!("{pid}.json")),
            format!(r#"{{"pid":{pid},"sessionId":"abc","procStart":"Thu Jan  1 00:00:00 1970"}}"#),
        )
        .unwrap();

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads.len(), 1);
        assert!(!threads[0].open_elsewhere);

        std::fs::remove_dir_all(&home).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_pid_that_started_when_it_says_is_the_conversation_open() {
        let home = temp_home();
        write_transcript(&home, "/tmp/x", "abc", &[r#"{"type":"summary","summary":"still here"}"#]);
        let pid = std::process::id();
        let started = crate::process::command("ps")
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let started = String::from_utf8_lossy(&started.stdout).trim().to_string();
        let dir = home.join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{pid}.json")),
            format!(r#"{{"pid":{pid},"sessionId":"abc","procStart":"{started}"}}"#),
        )
        .unwrap();

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert!(threads[0].open_elsewhere, "started {started}");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn rereads_a_transcript_only_once_it_changes() {
        let home = temp_home();
        let named = |name: &str| current_transcript("/tmp/x", &[format!(r#"{{"type":"ai-title","aiTitle":"{name}"}}"#)]);
        write_lines(&home, "/tmp/x", "abc", &named("one"));
        let path = home.join("projects").join(encode_project_path("/tmp/x")).join("abc.jsonl");
        assert_eq!(meta_cached(&path).title.as_deref(), Some("one"));

        // Rewritten in place, same size and time: taken for unchanged.
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        write_lines(&home, "/tmp/x", "abc", &named("two"));
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        assert_eq!(meta_cached(&path).title.as_deref(), Some("one"));

        let mut grown = named("two");
        grown.push(r#"{"type":"ai-title","aiTitle":"three"}"#.to_string());
        write_lines(&home, "/tmp/x", "abc", &grown);
        assert_eq!(meta_cached(&path).title.as_deref(), Some("three"));

        std::fs::remove_dir_all(&home).ok();
    }

    fn ids(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.id.as_str()).collect()
    }

    #[test]
    fn search_matches_every_term_somewhere() {
        let home = temp_home();
        let cwd = "/tmp/root/.worktrees/billing";
        write_lines(&home, cwd, "abc", &current_transcript(cwd, &[user("Walk the graph twice"), assistant("done")]));
        write_lines(&home, "/tmp/root", "other", &current_transcript("/tmp/root", &[user("walk elsewhere")]));
        let roots = ["/tmp/root".to_string()];

        assert_eq!(ids(&search_in(&home, &roots, "BILLING walk", &TextIndex::default())), ["abc"]);
        assert_eq!(ids(&search_in(&home, &roots, "billing nothing", &TextIndex::default())), Vec::<&str>::new());
        let walk = search_in(&home, &roots, "walk", &TextIndex::default());
        let mut both = ids(&walk);
        both.sort();
        assert_eq!(both, ["abc", "other"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_reads_text_not_tool_output() {
        let home = temp_home();
        let tool = serde_json::json!({
            "type": "user", "cwd": "$CWD",
            "message": {"content": [{"type": "tool_result", "content": "zebrafish appears in a file"}]},
        })
        .to_string();
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("look around"), tool]));

        assert!(search_in(&home, &["/tmp/x".to_string()], "zebrafish", &TextIndex::default()).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_gives_a_snippet_around_the_text_match() {
        let home = temp_home();
        let reply = format!("{} the parser drops comments {}", "a ".repeat(200), "b ".repeat(200));
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("why"), assistant(&reply)]));

        let hits = search_in(&home, &["/tmp/x".to_string()], "parser", &TextIndex::default());
        let snippet = hits[0].snippet.as_deref().expect("a snippet");
        assert!(snippet.contains("the parser drops comments"), "{snippet}");
        assert!(snippet.chars().count() < 140, "{snippet}");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_follows_a_growing_transcript() {
        let home = temp_home();
        let mut lines = current_transcript("/tmp/x", &[user("first")]);
        write_lines(&home, "/tmp/x", "abc", &lines);
        let roots = ["/tmp/x".to_string()];
        let index = TextIndex::default();
        assert!(search_in(&home, &roots, "afterwards", &index).is_empty());

        lines.push(user("and afterwards this").replace("$CWD", "/tmp/x"));
        write_lines(&home, "/tmp/x", "abc", &lines);
        assert_eq!(ids(&search_in(&home, &roots, "afterwards", &index)), ["abc"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_leaves_a_line_still_being_written_for_later() {
        let home = temp_home();
        let index = TextIndex::default();
        let roots = ["/tmp/x".to_string()];
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("first")]));
        let path = home.join("projects").join(encode_project_path("/tmp/x")).join("abc.jsonl");
        let half = user("a pelican arrives").replace("$CWD", "/tmp/x");
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(half.as_bytes()).unwrap();
        assert!(search_in(&home, &roots, "pelican", &index).is_empty());

        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"\n").unwrap();
        assert_eq!(ids(&search_in(&home, &roots, "pelican", &index)), ["abc"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_starts_over_on_a_transcript_rewritten_longer() {
        let home = temp_home();
        let index = TextIndex::default();
        let roots = ["/tmp/x".to_string()];
        write_lines(&home, "/tmp/x", "abc", &[user("about otters")]);
        assert_eq!(ids(&search_in(&home, &roots, "otters", &index)), ["abc"]);

        write_lines(&home, "/tmp/x", "abc", &[user("about beavers, and then a good deal more besides")]);
        assert!(search_in(&home, &roots, "otters", &index).is_empty());
        assert_eq!(ids(&search_in(&home, &roots, "beavers", &index)), ["abc"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_skips_what_claude_code_writes_for_slash_commands() {
        let home = temp_home();
        let lines = current_transcript(
            "/tmp/x",
            &[user("<command-name>/model</command-name>"), user("<local-command-stdout>Set model</local-command-stdout>"), user("hello")],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        assert!(search_in(&home, &["/tmp/x".to_string()], "model", &TextIndex::default()).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_forgets_transcripts_no_longer_searched() {
        let home = temp_home();
        let index = TextIndex::default();
        write_lines(&home, "/tmp/one", "a", &[user("shared word")]);
        write_lines(&home, "/tmp/two", "b", &[user("shared word")]);
        search_in(&home, &["/tmp/one".to_string(), "/tmp/two".to_string()], "shared", &index);
        assert_eq!(index.len(), 2);

        search_in(&home, &["/tmp/one".to_string()], "shared", &index);
        assert_eq!(index.len(), 1);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_transcript_reads_as_its_prompts_and_replies() {
        let home = temp_home();
        let tool_use = serde_json::json!({
            "type": "assistant", "cwd": "$CWD",
            "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]},
        })
        .to_string();
        let tool_result = serde_json::json!({
            "type": "user", "cwd": "$CWD",
            "message": {"content": [{"type": "tool_result", "content": "a file listing"}]},
        })
        .to_string();
        let lines = current_transcript(
            "/tmp/x",
            &[
                user("<command-name>/model</command-name>"),
                user("look at the importer").replace(r#""cwd""#, r#""timestamp":"2026-01-05T09:30:00.000Z","cwd""#),
                tool_use,
                tool_result,
                assistant("It drops every second row."),
            ],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        let transcript = transcript_in(&home, &["/tmp/x".to_string()], "abc").expect("a transcript");
        let said: Vec<(&str, &str)> = transcript.messages.iter().map(|m| (m.role.as_str(), m.text.as_str())).collect();
        assert_eq!(said, [("user", "look at the importer"), ("assistant", "It drops every second row.")]);
        assert_eq!(transcript.messages[0].at.as_deref(), Some("2026-01-05T09:30:00.000Z"));
        assert_eq!(transcript.earlier, 0);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_long_transcript_reads_as_its_latest_messages() {
        let home = temp_home();
        let mut lines = current_transcript("/tmp/x", &[]);
        for n in 0..250 {
            lines.push(user(&format!("message {n}")).replace("$CWD", "/tmp/x"));
        }
        lines.push(assistant(&"y".repeat(20_000)).replace("$CWD", "/tmp/x"));
        write_lines(&home, "/tmp/x", "abc", &lines);

        let transcript = transcript_in(&home, &["/tmp/x".to_string()], "abc").unwrap();
        assert_eq!(transcript.messages.len(), PREVIEW_MESSAGES);
        assert_eq!(transcript.earlier, 251 - PREVIEW_MESSAGES);
        assert_eq!(transcript.messages[0].text, format!("message {}", 251 - PREVIEW_MESSAGES));
        let last = &transcript.messages.last().unwrap().text;
        assert!(last.chars().count() <= PREVIEW_CHARS + 1 && last.ends_with('…'), "{}", last.len());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn no_transcript_for_a_conversation_not_there() {
        let home = temp_home();
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("hello")]));

        assert!(transcript_in(&home, &["/tmp/x".to_string()], "nope").is_none());
        assert!(transcript_in(&home, &["/tmp/elsewhere".to_string()], "abc").is_none());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn an_id_is_never_a_path_out_of_the_directories_asked_about() {
        let home = temp_home();
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("hello")]));
        write_lines(&home, "/tmp/other", "def", &current_transcript("/tmp/other", &[user("not yours")]));

        let asked = ["/tmp/x".to_string()];
        assert!(transcript_in(&home, &asked, "../-tmp-other/def").is_none());
        assert!(transcript_in(&home, &asked, "abc/../abc").is_none());
        assert!(transcript_in(&home, &asked, "abc.jsonl").is_none());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_preview_reads_what_was_added_since_the_last() {
        let home = temp_home();
        let index = TextIndex::default();
        let roots = ["/tmp/x".to_string()];
        let mut lines = current_transcript("/tmp/x", &[user("first")]);
        write_lines(&home, "/tmp/x", "abc", &lines);
        let said = |index: &TextIndex| -> Vec<String> {
            transcript_from(&home, &roots, "abc", index).unwrap().messages.into_iter().map(|m| m.text).collect()
        };
        assert_eq!(said(&index), ["first"]);

        lines.push(assistant("second").replace("$CWD", "/tmp/x"));
        write_lines(&home, "/tmp/x", "abc", &lines);
        assert_eq!(said(&index), ["first", "second"]);
        // And a search after it finds what it read.
        assert_eq!(ids(&search_in(&home, &roots, "second", &index)), ["abc"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_reply_with_text_beside_a_tool_call_is_still_read() {
        let home = temp_home();
        let both = serde_json::json!({
            "type": "assistant", "cwd": "$CWD",
            "message": {"content": [
                {"type": "text", "text": "Let me check the lighthouse"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
            ]},
        })
        .to_string();
        let tool_only = serde_json::json!({
            "type": "assistant", "cwd": "$CWD",
            "message": {"content": [{"type": "tool_use", "name": "Write", "input": {"content": "lighthouse keeper"}}]},
        })
        .to_string();
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("go"), both, tool_only]));

        let transcript = transcript_in(&home, &["/tmp/x".to_string()], "abc").unwrap();
        let said: Vec<&str> = transcript.messages.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(said, ["go", "Let me check the lighthouse"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn forgets_the_title_of_a_deleted_transcript() {
        let home = temp_home();
        write_lines(&home, "/tmp/x", "gone", &current_transcript("/tmp/x", &[user("soon deleted")]));
        let path = home.join("projects").join(encode_project_path("/tmp/x")).join("gone.jsonl");
        threads_for_home(&home, &["/tmp/x".to_string()]);
        let cached = || lock(META.get_or_init(Default::default)).contains_key(&path);
        assert!(cached());

        std::fs::remove_file(&path).unwrap();
        threads_for_home(&home, &["/tmp/x".to_string()]);
        assert!(!cached());

        std::fs::remove_dir_all(&home).ok();
    }

    /// A conversation a live `claude` has open is left out of the list, but
    /// a search and a preview still go to it, on every platform: where who
    /// started whom cannot be told (Windows), it was taken for one in a pane
    /// and skipped.
    #[test]
    fn search_and_preview_reach_a_conversation_a_live_process_has_open() {
        let home = temp_home();
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("about narwhals")]));
        write_session(&home, std::process::id() as u64, "abc");
        let roots = ["/tmp/x".to_string()];
        assert!(threads_in(&home, &roots, None).is_empty(), "left to its live row");

        assert_eq!(ids(&search_in(&home, &roots, "narwhals", &TextIndex::default())), ["abc"]);
        let transcript = transcript_in(&home, &roots, "abc").expect("a transcript");
        assert_eq!(transcript.messages[0].text, "about narwhals");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn search_folds_case_beyond_ascii() {
        let home = temp_home();
        write_lines(&home, "/tmp/x", "abc", &current_transcript("/tmp/x", &[user("Привет, Мир")]));

        let hits = search_in(&home, &["/tmp/x".to_string()], "мир", &TextIndex::default());
        assert_eq!(ids(&hits), ["abc"]);
        assert!(hits[0].snippet.as_deref().unwrap().contains("Мир"));

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn lists_more_than_thirty() {
        let home = temp_home();
        for n in 0..40 {
            write_lines(&home, "/tmp/x", &format!("id-{n}"), &current_transcript("/tmp/x", &[user(&format!("task {n}"))]));
        }

        assert_eq!(threads_for_home(&home, &["/tmp/x".to_string()]).len(), 40);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn finds_a_worktree_conversation_whose_cwd_is_only_in_the_tail() {
        let home = temp_home();
        let cwd = "/tmp/root/.worktrees/billing";
        // Attachments carry no cwd; far more of them than any head read.
        let mut lines = current_transcript(cwd, &[]);
        let filler = "x".repeat(5000);
        for _ in 0..20 {
            lines.push(format!(r#"{{"type":"attachment","attachment":{{"content":"{filler}"}}}}"#));
        }
        lines.push(user("review the billing page").replace("$CWD", cwd));
        lines.push(assistant("done").replace("$CWD", cwd));
        write_lines(&home, cwd, "abc", &lines);

        let threads = threads_for_home(&home, &["/tmp/root".to_string()]);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].cwd, cwd);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn leaves_out_sdk_runs() {
        let home = temp_home();
        let sdk = user("summarize the changelog").replace(r#""entrypoint":"cli""#, r#""entrypoint":"sdk-cli""#);
        write_lines(&home, "/tmp/x", "run", &current_transcript("/tmp/x", &[sdk]));
        write_lines(&home, "/tmp/x", "mine", &current_transcript("/tmp/x", &[user("by hand")]));

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["mine"]);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn carries_the_branch_it_was_last_on() {
        let home = temp_home();
        let lines = current_transcript(
            "/tmp/x",
            &[user("start"), assistant("ok").replace(r#""cwd""#, r#""gitBranch":"fix/billing-rounding","cwd""#)],
        );
        write_lines(&home, "/tmp/x", "abc", &lines);

        let threads = threads_for_home(&home, &["/tmp/x".to_string()]);
        assert_eq!(threads[0].branch.as_deref(), Some("fix/billing-rounding"));
        assert!(!threads[0].open_elsewhere);

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
    fn finds_a_conversation_in_a_descendant_directory() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/root/sub",
            "abc",
            &[r#"{"type":"summary","summary":"under the root","cwd":"/tmp/root/sub"}"#],
        );

        let threads = threads_for_home(&home, &["/tmp/root".to_string()]);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].cwd, "/tmp/root/sub");
        assert_eq!(threads[0].title, "under the root");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn does_not_treat_an_unrelated_sibling_as_a_descendant() {
        let home = temp_home();
        write_transcript(
            &home,
            "/tmp/root2",
            "abc",
            &[r#"{"type":"summary","summary":"a different repo"}"#],
        );

        let threads = threads_for_home(&home, &["/tmp/root".to_string()]);
        assert!(threads.is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_missing_project_directory_is_skipped_not_an_error() {
        let home = temp_home();
        let threads = threads_for_home(&home, &["/tmp/nope".to_string()]);
        assert!(threads.is_empty());
    }
}
