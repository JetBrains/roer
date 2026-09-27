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

use crate::roer;

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

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start `{}`: {e}", roer::bin()))?;
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
    let child = Arc::new(Mutex::new(child));

    state.sessions.lock().map_err(|_| poisoned())?.insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            child: Arc::clone(&child),
        },
    );

    let sessions = Arc::clone(&state.sessions);
    let done_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    // A send error means the webview dropped the channel
                    // (navigated away, or the view unmounted); stop reading.
                    if !on_event.push(PtyEvent::Output { data }) {
                        break;
                    }
                }
            }
        }

        let code = child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|status| status.exit_code() as i32);
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
    let mut sessions = state.sessions.lock().map_err(|_| poisoned())?;
    if let Some(session) = sessions.remove(&id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
