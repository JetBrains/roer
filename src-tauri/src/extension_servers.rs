//! Extension servers (`docs/extensions.md` §5): one Bun process per
//! extension whose manifest names a `server.ts`, spoken to in JSON-RPC over
//! its stdio by `extension_server.ts`.
//!
//! A server starts on the first `rpc` call to it, and stops when its
//! extension's sources change or the extension goes away; the next call
//! starts it again from the new sources. It dies with the app: its stdin
//! closing is its cue to exit.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::extensions::{bun, cache_dir, home, log, server_entry, valid_id};

const HOST_SCRIPT: &str = include_str!("extension_server.ts");

/// How long one call may take: a CLI that hangs must not hang the tab for good.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// The last lines a server wrote to stderr, kept for the error a call that
/// it died under reports.
const TAIL_LINES: usize = 20;

type Reply = Result<Value, String>;

struct Server {
    /// Of the sources it was started from.
    hash: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, Sender<Reply>>>>,
    /// stderr's last lines.
    tail: Arc<Mutex<Vec<String>>>,
    next_id: AtomicU64,
}

static SERVERS: Mutex<Option<HashMap<String, Arc<Server>>>> = Mutex::new(None);

fn servers() -> std::sync::MutexGuard<'static, Option<HashMap<String, Arc<Server>>>> {
    SERVERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The `PATH` a server runs with: the login shell's, so that a CLI the person
/// installed is found even by an app opened from the Finder, whose own `PATH`
/// is only the system's. Then the app's own, and the usual install folders.
fn server_path() -> OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(shell) = login_shell_path() {
            dirs.extend(std::env::split_paths(&shell));
        }
        if let Some(inherited) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&inherited));
        }
        if let Some(user) = crate::roer::home() {
            for sub in [".local/bin", ".bun/bin", ".cargo/bin"] {
                dirs.push(user.join(sub));
            }
        }
        if cfg!(unix) {
            dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
        }
        let mut seen = Vec::new();
        dirs.retain(|dir| {
            let new = !seen.contains(dir);
            seen.push(dir.clone());
            new
        });
        std::env::join_paths(dirs).unwrap_or_default()
    })
    .clone()
}

#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let output = crate::process::command(&shell)
            .args(["-l", "-c", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(output);
    });
    // A login profile that waits on something must not hold every server up.
    let output = rx.recv_timeout(Duration::from_secs(5)).ok()?.ok()?;
    let path = String::from_utf8(output.stdout).ok()?;
    (output.status.success() && !path.trim().is_empty()).then(|| path.trim().into())
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<OsString> {
    None
}

fn start(id: &str, entry: PathBuf, hash: String) -> Result<Arc<Server>, String> {
    let bun = bun(id)?;
    let script = home().join("extension-cache").join("server.ts");
    std::fs::create_dir_all(cache_dir(id)).map_err(|e| format!("{}: {e}", cache_dir(id).display()))?;
    std::fs::write(&script, HOST_SCRIPT).map_err(|e| format!("{}: {e}", script.display()))?;

    let mut child = crate::process::command(&bun)
        .arg(&script)
        .arg(id)
        .arg(&entry)
        .current_dir(entry.parent().unwrap_or(std::path::Path::new(".")))
        .env("PATH", server_path())
        .env("ROER_EXTENSION", id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", bun.display()))?;
    log(id, &format!("server started (pid {})", child.id()));

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let pending: Arc<Mutex<HashMap<u64, Sender<Reply>>>> = Arc::default();
    let tail: Arc<Mutex<Vec<String>>> = Arc::default();

    {
        let (id, tail) = (id.to_string(), tail.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log(&id, &format!("server: {line}"));
                let mut tail = tail.lock().unwrap();
                tail.push(line);
                let excess = tail.len().saturating_sub(TAIL_LINES);
                tail.drain(..excess);
            }
        });
    }
    {
        let (id, pending, tail) = (id.to_string(), pending.clone(), tail.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                match parse_reply(&line) {
                    Some((call, reply)) => {
                        if let Some(waiting) = pending.lock().unwrap().remove(&call) {
                            let _ = waiting.send(reply);
                        }
                    }
                    None => log(&id, &format!("server: {line}")),
                }
            }
            // stdout closed: the server is gone, and every call still waiting with it.
            // Give stderr a moment to deliver what it died saying.
            std::thread::sleep(Duration::from_millis(100));
            let said = tail.lock().unwrap().join("\n");
            let error = if said.is_empty() { format!("{id}'s server exited") } else { format!("{id}'s server exited:\n{said}") };
            log(&id, "server exited");
            for (_, waiting) in pending.lock().unwrap().drain() {
                let _ = waiting.send(Err(error.clone()));
            }
        });
    }

    Ok(Arc::new(Server {
        hash,
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending,
        tail,
        next_id: AtomicU64::new(1),
    }))
}

/// One line of the server's stdout, if it is an answer: `{ "roer-rpc": id, result | error }`.
fn parse_reply(line: &str) -> Option<(u64, Reply)> {
    let value: Value = serde_json::from_str(line).ok()?;
    let call = value.get("roer-rpc")?.as_u64()?;
    let reply = match value.get("error") {
        Some(error) if !error.is_null() => Err(error.as_str().map_or_else(|| error.to_string(), str::to_string)),
        _ => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
    };
    Some((call, reply))
}

fn alive(server: &Server) -> bool {
    matches!(server.child.lock().unwrap().try_wait(), Ok(None))
}

/// The extension's server, started from its current sources if it isn't running.
fn server(id: &str) -> Result<Arc<Server>, String> {
    let (entry, hash) = server_entry(id)?;
    let mut all = servers();
    let all = all.get_or_insert_with(HashMap::new);
    if let Some(running) = all.get(id) {
        if running.hash == hash && alive(running) {
            return Ok(running.clone());
        }
        kill(running);
    }
    let started = start(id, entry, hash)?;
    all.insert(id.to_string(), started.clone());
    Ok(started)
}

fn kill(server: &Server) {
    let mut child = server.child.lock().unwrap();
    let _ = child.kill();
    let _ = child.wait();
}

/// Stops an extension's server, if it runs. The next call starts it again.
pub(crate) fn stop(id: &str) {
    let stopped = servers().as_mut().and_then(|all| all.remove(id));
    if let Some(server) = stopped {
        kill(&server);
    }
}

/// Calls `method` on the extension's server with `params`, and returns what
/// its handler returned, or what it threw.
#[tauri::command(async)]
pub fn extension_rpc(id: String, method: String, params: Option<Value>) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err(format!("no such extension: {id}"));
    }
    let server = server(&id)?;
    let call = server.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    server.pending.lock().unwrap().insert(call, tx);
    let request = serde_json::json!({ "id": call, "method": method, "params": params.unwrap_or(Value::Null) });
    let written = {
        let mut stdin = server.stdin.lock().unwrap();
        writeln!(stdin, "{request}").and_then(|()| stdin.flush())
    };
    if let Err(e) = written {
        server.pending.lock().unwrap().remove(&call);
        let said = server.tail.lock().unwrap().join("\n");
        return Err(if said.is_empty() { format!("{id}'s server is not running: {e}") } else { format!("{id}'s server exited:\n{said}") });
    }
    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(reply) => reply,
        Err(_) => {
            server.pending.lock().unwrap().remove(&call);
            Err(format!("{id}: {method} did not answer within {}s", CALL_TIMEOUT.as_secs()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_answers_and_leaves_other_output_alone() {
        assert_eq!(parse_reply(r#"{"roer-rpc":3,"result":{"a":1}}"#), Some((3, Ok(serde_json::json!({ "a": 1 })))));
        assert_eq!(parse_reply(r#"{"roer-rpc":4,"result":null}"#), Some((4, Ok(Value::Null))));
        assert_eq!(parse_reply(r#"{"roer-rpc":5,"error":"boom"}"#), Some((5, Err("boom".into()))));
        assert_eq!(parse_reply(r#"{"id":5,"result":1}"#), None);
        assert_eq!(parse_reply("hello from the server"), None);
    }
}
