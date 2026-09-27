//! `roer-server`: the same commands the Tauri app exposes to its webview,
//! served over plain HTTP + one WebSocket, so a browser tab (or a remote
//! machine) can run the frontend without a native window at all.
//!
//! This is deliberately the same shape as Tauri's own IPC: `POST /api/invoke`
//! takes `{ "cmd": "...", "args": { ... } }`, exactly what the frontend's
//! `invoke(cmd, args)` already sends, and returns `{ "ok": true, "value": … }`
//! or `{ "ok": false, "error": "…" }`. The frontend's `invoke` shim
//! (`src/lib/backend.ts`) picks this transport over Tauri's own whenever it
//! is not running inside a Tauri webview — every call site elsewhere in the
//! app is unchanged.
//!
//! Native-only surface has no route here: the OS folder picker
//! (`@tauri-apps/plugin-dialog`) and the native window/menu/focus calls in
//! `handoff.rs` only mean something inside a desktop window. Everything else
//! — the terminal, git, file search, workspaces, projects, GitHub, Claude
//! setup, the Generative UI panel, personal tasks — is routed the same as
//! the desktop app.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;

use crate::events::Bus;
use crate::files::FileIndex;
use crate::pty::{PtyEvent, PtySink};

struct AppState {
    pty: crate::pty::PtyState,
    files: FileIndex,
    bus: Bus,
}

/// A `Channel`'s id, tagging pushes on the shared bus so the frontend's one
/// WebSocket can fan them back out to the right `Channel.onmessage`.
#[derive(Clone)]
struct ChannelBus {
    id: String,
    bus: Bus,
}

impl PtySink for ChannelBus {
    fn push(&self, event: PtyEvent) -> bool {
        self.bus.push_channel(&self.id, &event);
        true
    }
}

#[derive(Deserialize)]
struct Invoke {
    cmd: String,
    #[serde(default)]
    args: Value,
}

fn field(args: &Value, name: &str) -> Value {
    args.get(name).cloned().unwrap_or(Value::Null)
}

fn parse<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(field(args, name)).map_err(|e| format!("{name}: {e}"))
}

/// Runs the ambient rules every macro arm below leans on: `$args` is the
/// request's `args` object, and each `$field` is read by its camelCase name
/// (matching the frontend's own `invoke(cmd, { ...camelCase })` calls) with
/// no renaming to snake_case needed, since we read the JSON object by key
/// ourselves rather than deserializing into the Rust parameter names.
macro_rules! call {
    ($args:expr, $func:expr $(, $field:literal : $ty:ty)* $(,)?) => {{
        (|| -> Result<Value, String> {
            let value = $func($( parse::<$ty>(&$args, $field)? ),*);
            serde_json::to_value(value).map_err(|e| e.to_string())
        })()
    }};
}

/// Same as [`call!`], for a command whose Rust function already returns
/// `Result<T, String>`.
macro_rules! call_res {
    ($args:expr, $func:expr $(, $field:literal : $ty:ty)* $(,)?) => {{
        (|| -> Result<Value, String> {
            let value = $func($( parse::<$ty>(&$args, $field)? ),*)?;
            serde_json::to_value(value).map_err(|e| e.to_string())
        })()
    }};
}

fn dispatch(state: &AppState, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        // git
        "git_root" => call!(args, crate::git::git_root, "cwd": String),
        "git_diff" => call_res!(args, crate::git::git_diff, "root": String, "path": String, "untracked": bool),
        "git_branches" => call_res!(args, crate::git::git_branches, "cwd": String),
        "git_current_branch" => call_res!(args, crate::git::git_current_branch, "cwd": String),
        "git_branch_commits" => {
            call_res!(args, crate::git::git_branch_commits, "root": String, "branch": String, "base": String)
        }
        "git_commit_files" => call_res!(args, crate::git::git_commit_files, "root": String, "commit": String),
        "git_commit_diff" => {
            call_res!(args, crate::git::git_commit_diff, "root": String, "commit": String, "path": String)
        }
        "git_upstream_status" => call_res!(args, crate::git::git_upstream_status, "cwd": String),
        "git_changes" => {
            let cwd = parse(&args, "cwd")?;
            crate::git::git_changes_core(&state.bus, &state.files, cwd).and_then(|v| {
                serde_json::to_value(v).map_err(|e| e.to_string())
            })
        }

        // directory listing, for the browser tab's folder picker (the
        // native app uses a real OS picker instead — see `browse.rs`)
        "fs_list_dir" => call_res!(args, crate::browse::list_dir, "path": Option<String>),

        // files
        "files_search" => {
            let cwd = parse(&args, "cwd")?;
            let query = parse(&args, "query")?;
            let limit = parse(&args, "limit")?;
            crate::files::files_search_core(&state.bus, &state.files, cwd, query, limit)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "file_read" => {
            let root = parse(&args, "root")?;
            let path = parse(&args, "path")?;
            crate::files::file_read_core(&state.bus, &state.files, root, path)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }

        // roer sessions
        "roer_sessions" => call_res!(args, crate::roer::roer_sessions,),
        "roer_past_sessions" => call_res!(args, crate::roer::roer_past_sessions,),
        "roer_status" => call!(args, crate::roer::roer_status,),
        "roer_send" => call_res!(args, crate::roer::roer_send, "pane": String, "text": String),
        "roer_claude_threads" => call!(args, crate::claude::roer_claude_threads, "cwds": Vec<String>),

        // claude code setup
        "claude_setup_status" => call_res!(args, crate::claude_setup::claude_setup_status,),
        "claude_setup_apply" => {
            call_res!(args, crate::claude_setup::claude_setup_apply, "skills": bool, "mcp": bool)
        }
        "claude_setup_dismiss" => call_res!(args, crate::claude_setup::claude_setup_dismiss,),

        // workspaces
        "workspaces_list" => call!(args, crate::workspaces::workspaces_list,),
        "workspace_create" => call_res!(args, crate::workspaces::workspace_create, "name": String),
        "workspace_rename" => call_res!(args, crate::workspaces::workspace_rename, "id": String, "name": String),
        "workspace_delete" => call_res!(args, crate::workspaces::workspace_delete, "id": String),
        "workspace_attach_project" => call_res!(
            args, crate::workspaces::workspace_attach_project, "workspaceId": String, "projectId": String
        ),
        "workspace_detach_project" => call_res!(
            args, crate::workspaces::workspace_detach_project, "workspaceId": String, "projectId": String
        ),
        "workspace_add_item" => call_res!(
            args, crate::workspaces::workspace_add_item,
            "workspaceId": String, "kind": String, "title": String, "url": Option<String>
        ),
        "workspace_remove_item" => call_res!(
            args, crate::workspaces::workspace_remove_item, "workspaceId": String, "itemId": String
        ),
        "workspace_assignments" => call!(args, crate::workspaces::workspace_assignments,),
        "workspace_assign" => {
            call_res!(args, crate::workspaces::workspace_assign, "sessionId": String, "workspaceId": String)
        }
        "workspace_unassign" => call_res!(args, crate::workspaces::workspace_unassign, "sessionId": String),

        // projects
        "projects_list" => call!(args, crate::projects::projects_list,),
        "project_create" => call_res!(args, crate::projects::project_create, "name": String, "path": String),
        "project_rename" => call_res!(args, crate::projects::project_rename, "id": String, "name": String),
        "project_delete" => call_res!(args, crate::projects::project_delete, "id": String),

        // GitHub
        "gh_status" => call!(args, crate::gh::gh_status, "dir": String),
        "gh_pr_for_branch" => call_res!(args, crate::gh::gh_pr_for_branch, "dir": String),
        "gh_pr_create" => call_res!(
            args, crate::gh::gh_pr_create, "dir": String, "title": String, "body": String, "base": String, "draft": bool
        ),
        "gh_request_copilot_review" => {
            call_res!(args, crate::gh::gh_request_copilot_review, "dir": String, "number": u64)
        }
        "gh_pr_review" => call_res!(args, crate::gh::gh_pr_review, "dir": String, "number": u64),
        "gh_merge_methods" => call_res!(args, crate::gh::gh_merge_methods, "dir": String),
        "gh_pr_merge" => call_res!(
            args, crate::gh::gh_pr_merge, "dir": String, "number": u64, "method": String, "head": String
        ),
        // Opens on whatever machine `roer-server` runs on, not the browser
        // viewing it — fine when they are the same machine (the common
        // case), a known gap otherwise.
        "open_url" => call_res!(args, crate::gh::open_url, "url": String),

        // Generative UI panel bundles
        "report_plugin_ui_action" => {
            call_res!(args, crate::plugin_ui::report_plugin_ui_action, "action": crate::plugin_ui::PluginUiAction)
        }
        "list_plugin_ui_bundles" => call!(args, crate::plugin_ui::list_plugin_ui_bundles, "cwd": String),
        "read_plugin_ui_bundle" => {
            call_res!(args, crate::plugin_ui::read_plugin_ui_bundle, "cwd": String, "name": String)
        }
        "write_plugin_ui_bundle" => call_res!(
            args, crate::plugin_ui::write_plugin_ui_bundle,
            "cwd": String, "name": String, "bundle": crate::plugin_ui::PluginUiBundle
        ),

        // Handoffs (claim/ack/fail are plain file ops; "pending" skips the
        // native window-focus step `handoff_pending` does in the app).
        "handoff_pending" => call!(args, crate::handoff::handoff_pending_core,),
        "handoff_claim" => call_res!(args, crate::handoff::handoff_claim, "record": String),
        "handoff_ack" => call_res!(args, crate::handoff::handoff_ack, "record": String),
        "handoff_fail" => call_res!(args, crate::handoff::handoff_fail, "record": String),

        // pty
        "pty_spawn" => {
            let args_v: Vec<String> = parse(&args, "args")?;
            let cwd: Option<String> = parse(&args, "cwd")?;
            let cols: u16 = parse(&args, "cols")?;
            let rows: u16 = parse(&args, "rows")?;
            let channel_id: String = parse(&args, "onEvent")?;
            let sink = ChannelBus { id: channel_id, bus: state.bus.clone() };
            crate::pty::spawn(&state.pty, args_v, cwd, cols, rows, sink)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "pty_write" => {
            let id: String = parse(&args, "id")?;
            let data: String = parse(&args, "data")?;
            crate::pty::write(&state.pty, id, data)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "pty_resize" => {
            let id: String = parse(&args, "id")?;
            let cols: u16 = parse(&args, "cols")?;
            let rows: u16 = parse(&args, "rows")?;
            crate::pty::resize(&state.pty, id, cols, rows)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "pty_close" => {
            let id: String = parse(&args, "id")?;
            crate::pty::close(&state.pty, id)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }

        other => Err(format!("no such command: {other}")),
    }
}

async fn invoke(State(state): State<Arc<AppState>>, Json(body): Json<Invoke>) -> impl IntoResponse {
    match dispatch(&state, &body.cmd, body.args) {
        Ok(value) => Json(serde_json::json!({ "ok": true, "value": value })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn ws(upgrade: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.bus.0.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let msg = match msg {
                    Ok(msg) => msg,
                    // Falling behind more than the channel's capacity is a
                    // busy PTY, not a dead bus — skip what was missed and
                    // keep listening, rather than dropping the connection.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let Ok(text) = serde_json::to_string(&msg) else { continue };
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                // The socket is push-only from here; a close or error from
                // the browser is the only thing worth noticing.
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}

/// Boots the HTTP + WebSocket server. Blocks until the process is killed —
/// there is no window to close it from.
pub async fn serve(addr: SocketAddr) {
    let state = Arc::new(AppState {
        pty: crate::pty::PtyState::default(),
        files: FileIndex::default(),
        bus: Bus::new(),
    });

    // Same watchers the desktop app arms in `setup`, fed the server's bus
    // instead of an `AppHandle`. Handoff's own watcher is skipped: it exists
    // to bring a native window forward, which has no meaning here.
    if let Err(e) = crate::plugin_ui::watch(state.bus.clone()) {
        eprintln!("roer-server: could not start the plugin-UI watcher: {e}");
    }
    if let Err(e) = crate::pr_draft::watch(state.bus.clone()) {
        eprintln!("roer-server: could not start the PR-draft watcher: {e}");
    }

    let app = Router::new()
        .route("/api/invoke", post(invoke))
        .route("/api/ws", get(ws))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    println!("roer-server: listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("could not bind the server's address");
    axum::serve(listener, app).await.expect("server error");
}
