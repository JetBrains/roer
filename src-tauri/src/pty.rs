//! Roer owns a pseudo-terminal per view and pipes it to xterm.js.
//!
//! Both modes are the same code path: a PTY running the `roer` shim. Mode 1
//! is `roer shell`, mode 2 is `roer attach <pane>`. Only the arguments differ.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::{logfile, roer};

/// Pushed to the frontend over the session's channel.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Base64-encoded, so arbitrary byte sequences survive the JSON IPC
    /// intact — a PTY carries no guarantee of valid UTF-8 on frame
    /// boundaries, and a multi-byte glyph can straddle two reads.
    Output { data: String },
    /// The session ended. After a handoff this is how a terminal taking the
    /// session back shows up, so it is a normal event, not an error.
    Exit { code: Option<i32> },
}

/// Where a spawned PTY's [`PtyEvent`]s go — Tauri's own `Channel` inside the
/// app, or a tagged slot on `roer-server`'s WebSocket bus for a browser tab.
pub(crate) trait PtySink: Clone + Send + 'static {
    /// `false` means the other end is gone; the reader thread stops.
    fn push(&self, event: PtyEvent) -> bool;
}

impl PtySink for Channel<PtyEvent> {
    fn push(&self, event: PtyEvent) -> bool {
        self.send(event).is_ok()
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Log every write, under `ROER_TRACE_PTY`: the order input reached the
    /// PTY in, to tell a keystroke lost or reordered before the app's side
    /// from one lost after it.
    trace_input: bool,
}

pub struct PtyState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    next_id: AtomicU64,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

/// The locale variable to set, and to what, when the app's own does not say
/// UTF-8. LC_ALL outranks the rest, so an LC_ALL that says otherwise is the
/// one to replace; else LC_CTYPE, which is all tmux needs and leaves the
/// language of messages and dates to LANG.
fn utf8_locale(get: impl Fn(&str) -> Option<String>) -> Option<(&'static str, &'static str)> {
    let set = |var: &str| get(var).filter(|v| !v.is_empty());
    let effective = set("LC_ALL").or_else(|| set("LC_CTYPE")).or_else(|| set("LANG")).unwrap_or_default();
    let lower = effective.to_ascii_lowercase();
    if lower.contains("utf-8") || lower.contains("utf8") {
        return None;
    }
    // macOS has a bare UTF-8 character-type locale; glibc names it C.UTF-8.
    let value = if cfg!(target_os = "macos") { "UTF-8" } else { "C.UTF-8" };
    Some((if set("LC_ALL").is_some() { "LC_ALL" } else { "LC_CTYPE" }, value))
}

/// How much of a terminal's first output goes into the log. It is roer's
/// pane report and the start of tmux setting the terminal up, which is what
/// shows how far an attach got, and short enough to hold no screen of text.
const FIRST_OUTPUT: usize = 160;

/// Whether `ROER_TRACE_PTY` asks for the terminals' bytes to be kept.
fn tracing() -> bool {
    std::env::var_os("ROER_TRACE_PTY").is_some_and(|v| !v.is_empty())
}

/// With `ROER_TRACE_PTY` set, everything a terminal receives is also written
/// to a file of its own beside the log: the exact bytes, to replay into a
/// terminal when it draws something wrong. Opt-in, since it records whatever
/// was on screen. What is typed goes into the log itself, one line per
/// write (see `write`).
fn trace(id: &str) -> Option<std::fs::File> {
    if !tracing() {
        return None;
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let path = logfile::dir().join(format!("{id}-{stamp}.pty"));
    logfile::line(&format!("{id}: tracing output to {}", path.display()));
    std::fs::File::create(path).ok()
}

/// Bytes as the log can show them: control characters as escapes.
fn escaped(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).escape_debug().to_string()
}

fn poisoned() -> String {
    "pty state is poisoned".to_string()
}

/// Spawn `roer <args...>` on a new PTY and stream it to `on_event`.
#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, PtyState>,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    spawn(&state, args, cwd, cols, rows, on_event)
}

/// The spawn itself, generic over [`PtySink`] so `roer-server` can hand it a
/// WebSocket-backed sink instead of Tauri's own `Channel`.
pub(crate) fn spawn<P: PtySink>(
    state: &PtyState,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: P,
) -> Result<String, String> {
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = NativePtySystem::default()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(roer::bin());
    for arg in &args {
        cmd.arg(arg);
    }
    // Home rather than whatever the app was launched with: a session started
    // from the launcher belongs in the user's own directory, and the app's
    // working directory is an accident (`/` for a bundle opened from Finder).
    // Decided here because the frontend learns home asynchronously and cannot
    // answer for a click that lands before it does.
    match cwd.filter(|d| !d.is_empty()) {
        Some(dir) => cmd.cwd(dir),
        None => {
            if let Some(home) = roer::home() {
                cmd.cwd(home);
            }
        }
    }
    // tmux decides its colour capabilities from these, and its own
    // terminal-features override keys off a truecolor-capable outer TERM.
    // Without them an agent TUI renders in a degraded palette.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // tmux decides from the locale whether this client can take UTF-8, and
    // for one it thinks cannot, draws `_` for every character outside ASCII:
    // an agent's logo, prompt and status line. An app opened from Finder has
    // no locale at all. Whatever server this starts inherits it too, so the
    // shells in it read UTF-8 input as well.
    let locale = utf8_locale(|var| std::env::var(var).ok());
    if let Some((var, value)) = locale {
        cmd.env(var, value);
    }
    // Asks roer to say, in this terminal, which pane it attached: the only way
    // to know it for a session this starts. The frontend's terminal reads it.
    cmd.env("ROER_REPORT_PANE", "1");

    let command = format!("roer {} in {}", args.join(" "), cmd.get_cwd().map(|d| d.to_string_lossy()).unwrap_or_default());
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let e = format!("could not start `{}`: {e}", roer::bin());
        logfile::line(&format!("pty: {command}: {e}"));
        e
    })?;
    // Drop our own handle on the slave: while it is held open the reader
    // never sees EOF after the child exits, and the session looks hung
    // instead of finished.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read the pty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write the pty: {e}"))?;

    let id = format!("pty-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let locale = locale.map(|(var, value)| format!(", with {var}={value}")).unwrap_or_default();
    logfile::line(&format!("{id}: started {command} at {}x{}{locale}", size.cols, size.rows));
    let mut trace = trace(&id);
    let child = Arc::new(Mutex::new(child));

    state.sessions.lock().map_err(|_| poisoned())?.insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            child: Arc::clone(&child),
            trace_input: tracing(),
        },
    );

    let sessions = Arc::clone(&state.sessions);
    let done_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut sink_gone = false;
        let started = std::time::Instant::now();
        let mut total = 0usize;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if total == 0 {
                        logfile::line(&format!(
                            "{done_id}: first output after {} ms: {}",
                            started.elapsed().as_millis(),
                            escaped(&buf[..n.min(FIRST_OUTPUT)])
                        ));
                    }
                    total += n;
                    if let Some(file) = trace.as_mut() {
                        let _ = file.write_all(&buf[..n]);
                    }
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    // A send error means the webview dropped the channel
                    // (navigated away, or the view unmounted); stop reading.
                    if !on_event.push(PtyEvent::Output { data }) {
                        sink_gone = true;
                        break;
                    }
                }
            }
        }

        // With nobody reading, the client would run on forever: `wait` below
        // would never return, holding `child` — and `close`, which needs
        // that lock to kill it, would hang behind it.
        if sink_gone {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        }

        let code = child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|status| status.exit_code() as i32);
        logfile::line(&format!(
            "{done_id}: exited with {code:?} after {} ms and {total} bytes{}",
            started.elapsed().as_millis(),
            if sink_gone { ", its view gone" } else { "" }
        ));
        let _ = on_event.push(PtyEvent::Exit { code });

        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&done_id);
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    write(&state, id, data)
}

pub(crate) fn write(state: &PtyState, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| poisoned())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    if session.trace_input {
        logfile::line(&format!("{id}: input {}", escaped(data.as_bytes())));
    }
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    resize(&state, id, cols, rows)
}

pub(crate) fn resize(state: &PtyState, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| poisoned())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Kill the PTY. This ends Roer's *client*, not the tmux session behind it —
/// the session keeps running with no client, which is what makes it
/// reattachable from a terminal afterwards.
#[tauri::command]
pub fn pty_close(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    close(&state, id)
}

pub(crate) fn close(state: &PtyState, id: String) -> Result<(), String> {
    // Released before the kill: the reader thread can hold `child` while it
    // reaps, and every other PTY call must not queue up behind that.
    let session = state.sessions.lock().map_err(|_| poisoned())?.remove(&id);
    if let Some(session) = session {
        logfile::line(&format!("{id}: closed by its view"));
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Whether `id` is still a live session — false once it exited or was closed.
pub(crate) fn exists(state: &PtyState, id: &str) -> bool {
    state.sessions.lock().is_ok_and(|s| s.contains_key(id))
}

#[cfg(test)]
mod locale_tests {
    use super::utf8_locale;

    fn with<'a>(vars: &'a [(&str, &str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |var| vars.iter().find(|(k, _)| *k == var).map(|(_, v)| v.to_string())
    }

    #[test]
    fn a_utf8_locale_is_left_alone() {
        assert_eq!(utf8_locale(with(&[("LANG", "en_US.UTF-8")])), None);
        assert_eq!(utf8_locale(with(&[("LC_CTYPE", "UTF-8")])), None);
        assert_eq!(utf8_locale(with(&[("LC_ALL", "de_DE.utf8")])), None);
    }

    #[test]
    fn no_locale_gets_a_utf8_character_type() {
        let (var, value) = utf8_locale(with(&[])).unwrap();
        assert_eq!(var, "LC_CTYPE");
        assert!(value.contains("UTF-8"));
        assert_eq!(utf8_locale(with(&[("LANG", ""), ("LC_ALL", "")])).unwrap().0, "LC_CTYPE");
        assert_eq!(utf8_locale(with(&[("LANG", "en_US")])).unwrap().0, "LC_CTYPE");
    }

    #[test]
    fn an_lc_all_that_says_otherwise_is_the_one_replaced() {
        assert_eq!(utf8_locale(with(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")])).unwrap().0, "LC_ALL");
    }
}
