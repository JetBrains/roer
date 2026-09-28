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

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as SyncMutex, OnceLock};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use crate::assets::Frontend;
use crate::events::{Bus, ServerMsg};
use crate::files::FileIndex;
use crate::pty::{PtyEvent, PtySink};

/// How many not-yet-delivered [`ServerMsg::Channel`] messages a connection
/// can be holding before a PTY's reader thread blocks — backpressure rather
/// than the lossy drop a broadcast channel would give it.
const CHANNEL_BUFFER: usize = 256;

/// The cookie an authorized browser carries on every `/api/*` call after
/// `GET /api/session?token=...` once proved it knew the server's token.
const TOKEN_COOKIE: &str = "roer_token";

struct AppState {
    pty: crate::pty::PtyState,
    files: FileIndex,
    bus: Bus,
    /// Minted fresh each run; only ever handed to a browser that already
    /// proved it knows it, over `/api/session`.
    token: String,
    /// One entry per open WebSocket, by the connection id the frontend mints
    /// for its socket and sends on every `/api/invoke` call. `Channel`
    /// messages are unicast through here instead of the broadcast `bus`, so
    /// one tab's PTY output is never visible to another tab or to an
    /// arbitrary page that merely carries the auth cookie.
    connections: SyncMutex<HashMap<String, mpsc::Sender<ServerMsg>>>,
    /// Which connection owns a given `Channel` id, set when the command that
    /// created it (currently only `pty_spawn`) is dispatched.
    channel_owners: SyncMutex<HashMap<String, String>>,
}

/// 32 bytes of OS randomness, URL-safe so it drops straight into a query
/// string.
fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn carries_token(headers: &HeaderMap, expected: &str) -> bool {
    let Some(cookie) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    cookie.split(';').map(str::trim).any(|kv| kv.strip_prefix(TOKEN_COOKIE).and_then(|v| v.strip_prefix('=')) == Some(expected))
}

/// Guards `/api/invoke` and `/api/ws`: everything but `/api/session` itself,
/// which is how a browser gets the cookie this checks for in the first
/// place.
async fn require_token(State(state): State<Arc<AppState>>, req: Request<axum::body::Body>, next: Next) -> Response {
    if carries_token(req.headers(), &state.token) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "missing or invalid roer_token cookie — open /api/session?token=... first")
            .into_response()
    }
}

#[derive(Deserialize)]
struct SessionQuery {
    token: String,
}

/// The one route a browser can reach without already carrying the cookie:
/// proves it knows the server's token (from the URL `roer-server` printed at
/// startup) and gets a `SameSite=Strict`, `HttpOnly` cookie in return, so
/// every later call is authorized without the token being typed again. Then
/// redirects to `/` — this is what a browser actually lands on when it
/// opens the bootstrap link, not a page meant to be read.
async fn session(State(state): State<Arc<AppState>>, Query(q): Query<SessionQuery>) -> Response {
    if q.token != state.token {
        return (StatusCode::FORBIDDEN, "bad token").into_response();
    }
    let mut res = axum::response::Redirect::to("/").into_response();
    let cookie = format!("{TOKEN_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", state.token);
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        res.headers_mut().insert(header::SET_COOKIE, value);
    }
    res
}

/// A `Channel`'s id, routed to the one WebSocket connection that created it
/// (via `state.channel_owners`/`state.connections`) rather than broadcast to
/// every authorized tab.
#[derive(Clone)]
struct ChannelBus {
    id: String,
    state: Arc<AppState>,
}

impl PtySink for ChannelBus {
    /// `false` once the owning connection is gone — unknown owner, no such
    /// connection anymore, or its outgoing buffer's receiver was dropped —
    /// which is exactly what stops the PTY reader thread, matching how a
    /// dropped Tauri `Channel` behaves natively.
    fn push(&self, event: PtyEvent) -> bool {
        let Some(cid) = self.state.channel_owners.lock().unwrap().get(&self.id).cloned() else {
            return false;
        };
        let Some(sender) = self.state.connections.lock().unwrap().get(&cid).cloned() else {
            return false;
        };
        let Ok(payload) = serde_json::to_value(&event) else { return false };
        let msg = ServerMsg::Channel { id: self.id.clone(), payload };
        // Blocking, not `try_send`: this runs on the PTY's own reader
        // thread, never inside the Tokio runtime, so it is fine to apply
        // backpressure here instead of dropping output when the browser
        // can't keep up.
        sender.blocking_send(msg).is_ok()
    }
}

#[derive(Deserialize)]
struct Invoke {
    cmd: String,
    #[serde(default)]
    args: Value,
    /// The calling tab's WebSocket connection id (see `AppState::connections`),
    /// so a command that mints a `Channel` (`pty_spawn`) knows which
    /// connection to unicast its output to.
    #[serde(default)]
    cid: Option<String>,
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

fn dispatch(state: &Arc<AppState>, cmd: &str, args: Value, cid: Option<&str>) -> Result<Value, String> {
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
            let cid = cid.ok_or_else(|| "pty_spawn: missing connection id".to_string())?;
            state.channel_owners.lock().unwrap().insert(channel_id.clone(), cid.to_string());
            let sink = ChannelBus { id: channel_id, state: state.clone() };
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
    // `dispatch` shells out to git/gh, walks the filesystem, and spawns
    // PTYs — all blocking. Off the async task so one slow command can't
    // starve every other request and WebSocket delivery on this worker.
    let result = tokio::task::spawn_blocking(move || dispatch(&state, &body.cmd, body.args, body.cid.as_deref()))
        .await
        .unwrap_or_else(|e| Err(format!("the command task panicked: {e}")));
    match result {
        Ok(value) => Json(serde_json::json!({ "ok": true, "value": value })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[derive(Deserialize)]
struct WsQuery {
    /// The frontend's own connection id (`backend.ts`'s `connectionId`),
    /// minted once per tab — how `ChannelBus` finds this tab's outgoing
    /// buffer again for a `Channel` it created over a separate HTTP call.
    cid: String,
}

async fn ws(
    upgrade: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_ws(socket, state, q.cid))
}

/// Everything `/api/*` doesn't claim: the built frontend, embedded at
/// compile time (see `assets.rs`). Any path `Frontend` doesn't have falls
/// back to `index.html`, since the app is a client-routed single page.
async fn static_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(file) = Frontend::get(path).or_else(|| Frontend::get("index.html")) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut res = Response::new(Body::from(file.data.into_owned()));
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        res.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    res
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>, cid: String) {
    // `Event`s (file changes, handoffs, plugin UI) are fine for every
    // authorized tab to see and are disposable, so they still ride the
    // shared broadcast bus. `Channel` messages (PTY output) are unicast
    // through this connection's own buffer instead — see `ChannelBus`.
    let (tx, mut channel_rx) = mpsc::channel::<ServerMsg>(CHANNEL_BUFFER);
    state.connections.lock().unwrap().insert(cid.clone(), tx);
    let mut events_rx = state.bus.0.subscribe();

    loop {
        tokio::select! {
            msg = channel_rx.recv() => {
                let Some(msg) = msg else { break };
                let Ok(text) = serde_json::to_string(&msg) else { continue };
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            msg = events_rx.recv() => {
                let msg = match msg {
                    Ok(msg) => msg,
                    // Falling behind more than the channel's capacity is a
                    // busy watcher, not a dead bus — skip what was missed
                    // and keep listening, rather than dropping the
                    // connection. Fine for disposable `Event`s; PTY output
                    // no longer travels this path (see above).
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

    // Drops this connection's sender: any `ChannelBus::push` still targeting
    // it now finds no connection and returns `false`, stopping that PTY's
    // reader thread the same way a dropped Tauri `Channel` would natively.
    state.connections.lock().unwrap().remove(&cid);
    state.channel_owners.lock().unwrap().retain(|_, owner| owner != &cid);
}

/// A server bound and already accepting connections in the background.
pub struct Started {
    pub addr: SocketAddr,
    pub token: String,
}

impl Started {
    /// The one-time URL a browser opens to trade the token for the
    /// `roer_token` cookie, against this server's own address — it now
    /// serves the frontend itself, so nothing else needs to be running.
    pub fn bootstrap_url(&self) -> String {
        format!("http://{}/api/session?token={}", self.addr, self.token)
    }
}

/// Builds the router, binds `addr`, and spawns the accept loop, returning
/// as soon as it's listening rather than blocking for the server's whole
/// lifetime — so a caller (the desktop app, starting this in-process) gets
/// the bootstrap URL back right away.
async fn start(addr: SocketAddr) -> std::io::Result<Started> {
    // Bind first: if the port is already taken (e.g. a retried start after a
    // failed one), bail out before arming anything that would otherwise be
    // left running with nothing to shut it down.
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    let token = generate_token();
    let state = Arc::new(AppState {
        pty: crate::pty::PtyState::default(),
        files: FileIndex::default(),
        bus: Bus::new(),
        token: token.clone(),
        connections: SyncMutex::new(HashMap::new()),
        channel_owners: SyncMutex::new(HashMap::new()),
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

    // No CORS layer: this is a same-origin browser tab talking to its own
    // server, never a cross-origin caller, and the auth cookie is scoped
    // accordingly (`SameSite=Strict`). Opening CORS up would let any other
    // page on the machine's browser drive PTY/filesystem/Git/GitHub calls
    // here if it ever got hold of the cookie.
    let app = Router::new()
        .route("/api/invoke", post(invoke))
        .route("/api/ws", get(ws))
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        .route("/api/session", get(session))
        .fallback(static_asset)
        .with_state(state);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("roer-server: error: {e}");
        }
    });
    Ok(Started { addr: bound, token })
}

/// Boots the HTTP + WebSocket server and blocks until the process is
/// killed — there is no window to close it from.
pub async fn serve(addr: SocketAddr) {
    let started = start(addr).await.expect("could not bind the server's address");
    println!("roer-server: listening on http://{}", started.addr);
    println!("roer-server: open {} once per browser to authorize it", started.bootstrap_url());
    // A Vite dev server proxying /api elsewhere works too, at its own
    // origin's /api/session — same path and token, different host:port.
    println!(
        "roer-server: (or, via a frontend dev server proxying /api here: http://localhost:1420/api/session?token={} )",
        started.token
    );
    std::future::pending::<()>().await;
}

/// One server per app process: a second call while one is already running
/// (e.g. the menu action clicked twice) just hands back the same URL
/// instead of trying to bind the port again.
static RUNNING: OnceLock<Mutex<Option<Started>>> = OnceLock::new();

/// `127.0.0.1` unless overridden — safe by default, but a container or a
/// remote-machine deployment needs to bind `0.0.0.0` (or a specific
/// interface) to be reachable at all from outside the loopback interface.
pub fn default_addr() -> SocketAddr {
    let port: u16 = std::env::var("ROER_SERVER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4317);
    let host: std::net::IpAddr =
        std::env::var("ROER_SERVER_HOST").ok().and_then(|h| h.parse().ok()).unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    SocketAddr::from((host, port))
}

/// Starts the server in-process (spawned as a background task on the
/// caller's tokio runtime) so the desktop app can offer "open this session
/// in a browser tab" without a separate `roer-server` process, and opens the
/// bootstrap URL itself — `open_url`'s `https://`-only check exists for URLs
/// that came back from GitHub, not this `http://127.0.0.1` link the server
/// just minted for itself.
#[tauri::command(async)]
pub async fn start_browser_server() -> Result<(), String> {
    let cell = RUNNING.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().await;
    let url = if let Some(started) = &*guard {
        started.bootstrap_url()
    } else {
        let started = start(default_addr()).await.map_err(|e| e.to_string())?;
        let url = started.bootstrap_url();
        *guard = Some(started);
        url
    };
    crate::gh::open_in_system_browser(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_cookie_with_the_right_value() {
        let mut headers = HeaderMap::new();
        assert!(!carries_token(&headers, "secret"), "no cookie header at all");

        headers.insert(header::COOKIE, HeaderValue::from_static("roer_token=wrong"));
        assert!(!carries_token(&headers, "secret"));

        headers.insert(header::COOKIE, HeaderValue::from_static("roer_token=secret"));
        assert!(carries_token(&headers, "secret"));

        // Alongside other cookies, in either order, with the usual spacing.
        headers.insert(header::COOKIE, HeaderValue::from_static("theme=dark; roer_token=secret"));
        assert!(carries_token(&headers, "secret"));

        // A cookie whose name merely starts with "roer_token" is not a match.
        headers.insert(header::COOKIE, HeaderValue::from_static("roer_token_extra=secret"));
        assert!(!carries_token(&headers, "secret"));
    }

    #[test]
    fn mints_a_fresh_url_safe_token_every_time() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{a}");
    }
}
