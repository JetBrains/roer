//! Roer's extensions as MCP Apps, for clients that draw them (the Claude app,
//! the Codex app). `open_extension` names one page, `ui://roer/extension`,
//! which the client draws in a sandboxed iframe: React, the `roer` SDK and
//! `roer/ui` (src/mcp-app, built by `npm run build:mcp-app`). The page reaches
//! back here through `roer_ext_call`, a tool only it is offered: to have the
//! extension built, and to run what its tab asks the backend for.
//!
//! No Roer app is needed. The extension is built with Bun here, with the app's
//! own build script, and its `server.ts` runs here with the app's own host
//! script. Only an extension whose manifest lists `"mcp-app"` in `hosts`
//! opens: its author has seen it work outside Roer.
//!
//! Opens and failures are appended to `$ROER_HOME/mcp-apps.log`, with what
//! each client said of itself when it connected.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::{records, Fail};

pub const LOADER_URI: &str = "ui://roer/extension";
const LOADER_MIME: &str = "text/html;profile=mcp-app";

pub const OPEN: &str = "open_extension";
pub const CALL: &str = "roer_ext_call";

/// The app's own scripts, so an extension builds and serves here as it does there.
const BUILD_SCRIPT: &str = include_str!("../../src-tauri/src/extension_build.ts");
const SERVER_SCRIPT: &str = include_str!("../../src-tauri/src/extension_server.ts");

/// What a manifest lists in `hosts` to open in these clients.
const HOST: &str = "mcp-app";

/// How long one call into an extension's server may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

pub fn resource() -> Value {
    json!({
        "uri": LOADER_URI,
        "name": "Roer extension",
        "description": "Draws a Roer extension's tab.",
        "mimeType": LOADER_MIME,
    })
}

/// The page's built JS and CSS: `$ROER_MCP_APP` (a `dist-mcp-app` folder), else this checkout's `dist-mcp-app`.
fn runtime() -> Result<(String, String), PathBuf> {
    let from = |dir: PathBuf| match (std::fs::read_to_string(dir.join("runtime.js")), std::fs::read_to_string(dir.join("runtime.css"))) {
        (Ok(js), Ok(css)) => Ok((js, css)),
        _ => Err(dir),
    };
    if let Some(dir) = std::env::var_os("ROER_MCP_APP").filter(|v| !v.is_empty()) {
        return from(PathBuf::from(dir));
    }
    from(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist-mcp-app"))
}

/// The page, whole: the runtime's CSS and JS inline, since the client's iframe fetches nothing else.
pub fn read() -> Value {
    let body = match runtime() {
        Ok((js, css)) => format!(
            "<style>{}</style>\n<div id=\"root\"></div>\n<script type=\"module\">{}</script>",
            css.replace("</style", "<\\/style"),
            js.replace("</script", "<\\/script")
        ),
        Err(dir) => {
            log(&json!({ "event": "no-runtime", "dir": dir }));
            format!(
                "<p style=\"font-family: sans-serif; padding: 16px\">This roer has no extension page built: run \
                 <code>npm run build:mcp-app</code> in the Roer checkout ({}).</p>",
                html_escape(&dir.display().to_string())
            )
        }
    };
    let html = format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, \
         initial-scale=1\">\n<title>Roer extension</title>\n</head>\n<body>\n{body}\n</body>\n</html>\n"
    );
    json!({
        "uri": LOADER_URI,
        "mimeType": LOADER_MIME,
        "text": html,
        "_meta": { "ui": { "prefersBorder": true } },
    })
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// An extension that opens here: its id, name and folder.
struct Portable {
    id: String,
    name: String,
    dir: PathBuf,
    manifest: Value,
}

fn portable() -> Vec<Portable> {
    crate::ext::found()
        .into_iter()
        .filter_map(|(id, _, dir)| {
            let manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("extension.json")).ok()?).ok()?;
            let hosts = manifest.get("hosts")?.as_array()?;
            if !hosts.iter().any(|h| h == HOST) {
                return None;
            }
            let name = manifest.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(Portable { id, name, dir, manifest })
        })
        .collect()
}

pub fn tools() -> Vec<Value> {
    let offered = portable();
    // Each with what its manifest says it is, so the model can match "show me my deck" to one without being
    // told its id.
    let which = if offered.is_empty() {
        "None of the user's extensions opens here yet: one does once its extension.json lists \"mcp-app\" in \"hosts\".".to_string()
    } else {
        let rows: Vec<String> = offered
            .iter()
            .map(|p| match p.manifest.get("description").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                Some(what) => format!("- {}: {} — {what}", p.id, p.name),
                None => format!("- {}: {}", p.id, p.name),
            })
            .collect();
        format!("The user's extensions that open here, by id:\n{}", rows.join("\n"))
    };
    let where_ = match last_cwd() {
        Some(cwd) => format!("Without a cwd, a tab works in the folder the user last worked in in Roer, {cwd}."),
        None => "Without a cwd, a tab has no project folder.".to_string(),
    };
    vec![
        json!({
            "name": OPEN,
            "description": format!("Open one of the user's own Roer extensions right here in the conversation: its \
                tab, live and interactive, as it is in Roer. Call it whenever the user asks to see, open, show or \
                present something one of these is for, even without naming it or Roer, and pick the id yourself; \
                ask only when two fit equally. {where_} When the tab fails, its error reaches you in the tab's \
                context, and the whole of it is in extension_logs: fix it and open it again. \
                {which}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The extension's id." },
                    "tab": { "type": "string", "description": "The tab's id, when the extension has more than one." },
                    "cwd": { "type": "string", "description": "The project directory the extension works in, when the user named one." },
                },
                "required": ["id"],
            },
            "_meta": { "ui": { "resourceUri": LOADER_URI }, "ui/resourceUri": LOADER_URI },
        }),
        json!({
            "name": CALL,
            "description": "Called by Roer's extension view, not by the model.",
            "inputSchema": {
                "type": "object",
                "properties": { "method": { "type": "string" } },
                "required": ["method"],
            },
            "_meta": { "ui": { "visibility": ["app"] } },
        }),
    ]
}

/// A tool's whole result. `roer_ext_call` answers in JSON text, which the page parses.
pub fn call(name: &str, args: &Value) -> Result<Value, Fail> {
    let text = match name {
        OPEN => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            log(&json!({ "event": "open", "args": args }));
            let Some(found) = portable().into_iter().find(|p| p.id == id) else {
                return Err(Fail::new(2, format!("no extension {id:?} opens here. {}", tools()[0]["description"].as_str().unwrap_or_default())));
            };
            format!(
                "Showing {} ({}) to the user. They work in it themselves; what they send from it arrives as their \
                 next message. In a client that cannot draw MCP Apps there is nothing to see.",
                found.name, found.id
            )
        }
        CALL => {
            let answer = page_call(args).inspect_err(|fail| {
                log(&json!({ "event": "failed", "args": brief(args), "error": fail.message }));
                if let Some(id) = args.get("id").and_then(Value::as_str).filter(|id| crate::ext::is_id(id)) {
                    let command = args.get("command").and_then(Value::as_str);
                    let what = match (command, args.pointer("/args/method").and_then(Value::as_str)) {
                        (Some("extension_rpc"), Some(method)) => format!("server.ts's {method}"),
                        (Some(command), _) => command.to_string(),
                        _ => args.get("method").and_then(Value::as_str).unwrap_or("call").to_string(),
                    };
                    ext_log(id, &format!("outside Roer: {what} failed: {}", fail.message));
                }
            })?;
            answer.to_string()
        }
        _ => return Err(Fail::new(2, format!("unknown tool: {name}"))),
    };
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

/// A call's arguments for the log, without a payload the size of a PowerPoint file.
fn brief(args: &Value) -> Value {
    let text = args.to_string();
    if text.len() <= 500 {
        args.clone()
    } else {
        json!(format!("{}…", &text[..text.char_indices().nth(500).map_or(text.len(), |(i, _)| i)]))
    }
}

fn page_call(args: &Value) -> Result<Value, Fail> {
    let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
    let found = portable().into_iter().find(|p| p.id == id).ok_or_else(|| Fail::new(2, format!("no extension {id:?} opens here")))?;
    match args.get("method").and_then(Value::as_str).unwrap_or_default() {
        "load" => {
            let (js, css) = build(&found)?;
            let cwd = args.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string).or_else(last_cwd);
            Ok(json!({ "id": found.id, "name": found.name, "js": js, "css": css, "cwd": cwd }))
        }
        "report" => {
            let message = args.get("message").and_then(Value::as_str).unwrap_or_default();
            ext_log(&found.id, &format!("outside Roer: {message}"));
            Ok(json!({}))
        }
        "invoke" => {
            let command = args.get("command").and_then(Value::as_str).unwrap_or_default();
            let call = args.get("args").cloned().unwrap_or(Value::Null);
            match command {
                "extension_rpc" => {
                    let method = call.get("method").and_then(Value::as_str).unwrap_or_default();
                    let params = call.get("params").cloned().unwrap_or(Value::Null);
                    Ok(json!({ "value": rpc(&found, method, params)? }))
                }
                other => Err(Fail::new(
                    3,
                    format!("{other} is not available outside Roer yet: only the extension's own server.ts is"),
                )),
            }
        }
        other => Err(Fail::new(2, format!("unknown method: {other}"))),
    }
}

/// Where the user last worked in Roer: the folder of the session touched last, if it is still there. What a
/// tab opened without a `cwd` works in.
pub fn last_cwd() -> Option<String> {
    let text = std::fs::read_to_string(records::home().join("sessions.json")).ok()?;
    let sessions: Value = serde_json::from_str(&text).ok()?;
    sessions["sessions"]
        .as_object()?
        .values()
        .filter_map(|s| Some((s["updatedAt"].as_u64().unwrap_or(0), s["cwd"].as_str()?.to_string())))
        .filter(|(_, cwd)| Path::new(cwd).is_dir())
        .max_by_key(|(at, _)| *at)
        .map(|(_, cwd)| cwd)
}

fn cache_dir(id: &str) -> PathBuf {
    records::home().join("mcp-app-cache").join(id)
}

/// Builds the extension's app as one script that hands its `defineExtension` to the page, which runs it as an
/// inline module: what every client's CSP lets through, where importing a blob or a data URL is not.
fn build(found: &Portable) -> Result<(String, String), Fail> {
    let app = found.manifest.get("app").and_then(Value::as_str).ok_or_else(|| Fail::new(2, format!("{} has no app", found.id)))?;
    let entry = found.dir.join(app);
    let cache = cache_dir(&found.id);
    let out = cache.join("out");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&cache).map_err(|e| Fail::new(1, format!("{}: {e}", cache.display())))?;
    let wrapper = cache.join("entry.ts");
    let script = cache.join("build.ts");
    let wrapped = format!(
        "import extension from {};\nglobalThis.__roerExtension = extension;\nwindow.dispatchEvent(new Event(\"roer-extension\"));\n",
        json!(entry.to_string_lossy())
    );
    for (path, text) in [(&wrapper, wrapped.as_str()), (&script, BUILD_SCRIPT)] {
        std::fs::write(path, text).map_err(|e| Fail::new(1, format!("{}: {e}", path.display())))?;
    }
    let output = Command::new(bun()?)
        .arg(&script)
        .arg(&wrapper)
        .arg(&out)
        .env("NODE_ENV", "production")
        .current_dir(&found.dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Fail::new(1, format!("could not run Bun: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let report: Value = stdout.lines().rev().find_map(|line| serde_json::from_str(line).ok()).unwrap_or(Value::Null);
    if report["ok"] != json!(true) {
        let logs: Vec<String> = report["logs"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect();
        let why = if logs.is_empty() { String::from_utf8_lossy(&output.stderr).trim().to_string() } else { logs.join("\n") };
        return Err(Fail::new(1, format!("{} did not build:\n{why}", found.id)));
    }
    let js = std::fs::read_to_string(out.join("app.js")).map_err(|e| Fail::new(1, format!("{}: {e}", out.join("app.js").display())))?;
    let css = std::fs::read_to_string(out.join("app.css")).unwrap_or_default();
    Ok((js, css))
}

/// The Bun to build and serve with: `ROER_BUN`, the one beside this roer, the one Roer downloaded, then Bun's
/// own install and the usual folders.
fn bun() -> Result<PathBuf, Fail> {
    if let Some(explicit) = std::env::var_os("ROER_BUN").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(explicit));
    }
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        candidates.push(dir.join(name));
    }
    if let Ok(versions) = std::fs::read_dir(records::home().join("bun")) {
        candidates.extend(versions.flatten().map(|v| v.path().join(name)));
    }
    candidates.push(records::user_home().join(".bun").join("bin").join(name));
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(|dir| Path::new(dir).join(name)));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| Fail::new(3, "Roer's extensions are built with Bun, and none was found: install it from bun.sh, or set ROER_BUN"))
}

/// An extension's `server.ts`, run by the app's host script: requests in on stdin, answers out on stdout.
struct Server {
    /// Of the folder it was started from: a server from older sources is stopped and started again.
    hash: u64,
    child: Child,
    stdin: ChildStdin,
    next: u64,
    pending: Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>,
}

static SERVERS: Mutex<Option<HashMap<String, Server>>> = Mutex::new(None);

fn start(found: &Portable) -> Result<Server, Fail> {
    let server = found.manifest.get("server").and_then(Value::as_str).ok_or_else(|| Fail::new(2, format!("{} has no server.ts", found.id)))?;
    let entry = found.dir.join(server);
    let cache = cache_dir(&found.id);
    std::fs::create_dir_all(&cache).map_err(|e| Fail::new(1, format!("{}: {e}", cache.display())))?;
    let script = cache.join("server.ts");
    std::fs::write(&script, SERVER_SCRIPT).map_err(|e| Fail::new(1, format!("{}: {e}", script.display())))?;
    let mut child = Command::new(bun()?)
        .arg(&script)
        .arg(&found.id)
        .arg(&entry)
        .current_dir(&found.dir)
        .env("ROER_EXTENSION", &found.id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Fail::new(1, format!("could not run Bun: {e}")))?;
    let stdin = child.stdin.take().ok_or_else(|| Fail::new(1, "no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| Fail::new(1, "no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| Fail::new(1, "no stderr"))?;
    let pending: Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>> = Arc::default();
    let id = found.id.clone();
    ext_log(&id, &format!("server started outside Roer (pid {})", child.id()));
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            ext_log(&id, &format!("server: {line}"));
        }
        ext_log(&id, "server exited");
    });
    let waiting = pending.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(reply) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(call) = reply.get("roer-rpc").and_then(Value::as_u64) else { continue };
            let answer = match reply.get("error") {
                Some(error) if !error.is_null() => Err(error.as_str().map_or_else(|| error.to_string(), str::to_string)),
                _ => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
            };
            if let Some(tx) = waiting.lock().unwrap().remove(&call) {
                let _ = tx.send(answer);
            }
        }
        // Gone: so is every call still waiting on it.
        for (_, tx) in waiting.lock().unwrap().drain() {
            let _ = tx.send(Err("the extension's server exited".into()));
        }
    });
    Ok(Server { hash: fingerprint(&found.dir), child, stdin, next: 1, pending })
}

/// The folder's files, by path, size and time: what changes when anything in it is written.
fn fingerprint(dir: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    fn walk(dir: &Path, hasher: &mut std::collections::hash_map::DefaultHasher) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name == "node_modules" || name == ".git" {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&entry.path(), hasher);
            } else {
                entry.path().hash(hasher);
                meta.len().hash(hasher);
                meta.modified().ok().hash(hasher);
            }
        }
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    walk(dir, &mut hasher);
    hasher.finish()
}

fn rpc(found: &Portable, method: &str, params: Value) -> Result<Value, Fail> {
    let rx: Receiver<Result<Value, String>> = {
        let mut all = SERVERS.lock().unwrap_or_else(|p| p.into_inner());
        let all = all.get_or_insert_with(HashMap::new);
        let hash = fingerprint(&found.dir);
        let current = all.get_mut(&found.id).is_some_and(|s| s.hash == hash && matches!(s.child.try_wait(), Ok(None)));
        if !current {
            if let Some(mut old) = all.remove(&found.id) {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
            all.insert(found.id.clone(), start(found)?);
        }
        let server = all.get_mut(&found.id).expect("just started");
        let call = server.next;
        server.next += 1;
        let (tx, rx) = channel();
        server.pending.lock().unwrap().insert(call, tx);
        let request = json!({ "id": call, "method": method, "params": params });
        writeln!(server.stdin, "{request}")
            .and_then(|()| server.stdin.flush())
            .map_err(|e| Fail::new(1, format!("{}'s server: {e}", found.id)))?;
        rx
    };
    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(answer) => answer.map_err(|e| Fail::new(1, e)),
        Err(_) => Err(Fail::new(1, format!("{}'s server did not answer {method} in {}s", found.id, CALL_TIMEOUT.as_secs()))),
    }
}

/// What a client said of itself in `initialize`: whether it offers MCP Apps
/// at all is in its capabilities, under `extensions`.
pub fn log_client(params: &Value) {
    log(&json!({
        "event": "initialize",
        "client": params.get("clientInfo"),
        "protocolVersion": params.get("protocolVersion"),
        "capabilities": params.get("capabilities"),
    }));
}

/// Server output arrives on threads of its own: one at a time, each line written whole.
static LOG: Mutex<()> = Mutex::new(());

fn log(entry: &Value) {
    let path = records::home().join("mcp-apps.log");
    let line = format!("{}\n", json!({ "at": records::now_rfc3339(), "pid": std::process::id(), "entry": entry }));
    let _guard = LOG.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// A line in the extension's own log, the one `extension_logs` and `roer ext logs` read, as the app writes it:
/// what an agent fixing the extension looks at first.
fn ext_log(id: &str, message: &str) {
    let dir = records::home().join("extension-cache").join(id);
    let _ = std::fs::create_dir_all(&dir);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let text: String = message.lines().map(|line| format!("{secs} {line}\n")).collect();
    let _guard = LOG.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("log")) {
        let _ = file.write_all(text.as_bytes());
    }
}
