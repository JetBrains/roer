//! `roer mcp`: Roer's MCP server, over stdio, for Claude Code, the Claude app
//! and any other MCP client.
//!
//! What it offers depends on where it was started. An agent in a pane of
//! Roer's own server (Claude Code run in a Roer session, which starts this as
//! its child and so passes on `$TMUX` and `$TMUX_PANE`) gets tools for its own
//! session. Started anywhere else, by the Claude app say, it has no session of
//! its own, and every tool names the session it acts on.
//!
//! Except for Claude Code outside a Roer session: there it offers nothing at
//! all, not even instructions, so a plain terminal's Claude carries none of
//! Roer in its context. Claude Code sends `clientInfo.name` "claude-code"; the
//! Claude app, which has no Roer session of its own to be in, keeps the tools.
//!
//! JSON-RPC 2.0, one message per line, as MCP's stdio transport has it. Only
//! the few methods a tools-only server needs; stdout carries nothing else.

use std::cell::Cell;
use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::{emit_plugin_ui, Fail, Roer};

/// What the Generative UI panel draws: the message kinds and the catalog.
const GUIDE: &str = include_str!("mcp-guide.md");

/// The protocol revisions this server speaks, newest last. It has no use for
/// anything newer than tools, so it answers each in kind.
const VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

pub fn serve(roer: &Roer) -> Result<(), Fail> {
    let server = Server { roer, here: roer.tmux.inside_roer().ok(), idle: Cell::new(false) };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => server.handle(&message),
            Err(e) => Some(error(Value::Null, -32700, &format!("not JSON: {e}"))),
        };
        if let Some(reply) = reply {
            let sent = writeln!(stdout, "{reply}").and_then(|()| stdout.flush());
            if sent.is_err() {
                break;
            }
        }
    }
    Ok(())
}

struct Server<'a> {
    roer: &'a Roer,
    /// The pane this server's agent runs in, when that is a Roer session.
    here: Option<String>,
    /// Offering nothing: Claude Code, outside a Roer session.
    idle: Cell<bool>,
}

impl Server<'_> {
    /// The reply to one message; none for a notification.
    fn handle(&self, message: &Value) -> Option<Value> {
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let id = message.get("id").cloned()?;
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[VERSIONS.len() - 1]);
                let client = params.pointer("/clientInfo/name").and_then(Value::as_str).unwrap_or_default();
                self.idle.set(self.here.is_none() && client == "claude-code");
                let mut reply = json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "roer", "version": env!("CARGO_PKG_VERSION") },
                });
                if !self.idle.get() {
                    reply["instructions"] = self.instructions().into();
                }
                result(id, reply)
            }
            "ping" => result(id, json!({})),
            "tools/list" => result(id, json!({ "tools": self.tools() })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                // A tool's failure is its result, for the model to read; only a
                // malformed request is a protocol error.
                let outcome = self.call(name, &args);
                let (text, is_error) = match outcome {
                    Ok(text) => (text, false),
                    Err(fail) => (fail.message, true),
                };
                result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
            }
            _ => error(id, -32601, &format!("method not found: {method}")),
        })
    }

    fn instructions(&self) -> String {
        let scope = if self.here.is_some() {
            "This agent is running in a Roer session: `show_ui` and `read_ui_actions` act on it unless given \
             another `session`, and `save_ui`/`load_ui` keep plugin UIs with this project."
        } else {
            "This agent is not running in a Roer session, so each tool needs the `session` to act on: \
             the name Roer shows for it. Ask the user which session if they have not said."
        };
        format!("{scope}\n\n{GUIDE}")
    }

    fn tools(&self) -> Vec<Value> {
        if self.idle.get() {
            return Vec::new();
        }
        let session = if self.here.is_some() {
            json!({ "type": "string", "description": "A Roer session's name, to act on it rather than this one." })
        } else {
            json!({ "type": "string", "description": "The Roer session to act on, by the name Roer shows for it." })
        };
        let required = |mut names: Vec<&'static str>| {
            if self.here.is_none() {
                names.push("session");
            }
            names
        };
        let mut tools = vec![
            json!({
                "name": "show_ui",
                "description": "Show or update a UI in a Roer session's Generative UI panel. `messages` is the \
                    sequence to send: surfaceUpdate, any dataModelUpdate, then beginRendering. The message \
                    kinds and the whole component catalog are in this server's instructions.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "messages": { "type": "array", "items": { "type": "object" }, "minItems": 1 },
                        "session": session,
                    },
                    "required": required(vec!["messages"]),
                },
            }),
            json!({
                "name": "read_ui_actions",
                "description": "The button clicks waiting in a Roer session's Generative UI panel, oldest first, \
                    each as one JSON object per line and consumed as it is read. Empty when nothing was clicked.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "session": session },
                    "required": required(vec![]),
                },
            }),
        ];
        if self.here.is_some() {
            let name = json!({ "type": "string", "description": "Letters, digits, - and _ only." });
            tools.push(json!({
                "name": "save_ui",
                "description": "Save a plugin UI under this project's .roer/plugin-ui/bundles/<name>/, to show \
                    again later with load_ui or from Roer's own list. Save once the user is satisfied with it. \
                    Before drafting a new UI, read .roer/plugin-ui/style-guide.md if the project has one.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": name,
                        "surfaceUpdate": { "type": "object" },
                        "dataModelUpdate": { "type": "object" },
                        "prompt": { "type": "string", "description": "The request that produced it." },
                    },
                    "required": ["name", "surfaceUpdate"],
                },
            }));
            tools.push(json!({
                "name": "load_ui",
                "description": "Show a plugin UI saved in this project with save_ui.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "name": name },
                    "required": ["name"],
                },
            }));
        }
        tools
    }

    fn call(&self, name: &str, args: &Value) -> Result<String, Fail> {
        if self.idle.get() {
            return Err(Fail::new(3, "Roer's tools are only offered to Claude Code running in a Roer session"));
        }
        match name {
            "show_ui" => {
                let pane = self.pane(args)?;
                let messages = args.get("messages").and_then(Value::as_array).filter(|m| !m.is_empty());
                let messages = messages.ok_or_else(|| Fail::new(2, "`messages` needs at least one message"))?;
                for (n, message) in messages.iter().enumerate() {
                    emit_plugin_ui(&pane, message.clone(), n as u32 + 1)?;
                }
                Ok(format!("Sent {} message(s) to the Generative UI panel.", messages.len()))
            }
            "read_ui_actions" => Ok(Roer::take_actions(&self.pane(args)?)?.join("\n")),
            "save_ui" if self.here.is_some() => {
                let name = text(args, "name");
                let surface = args.get("surfaceUpdate").ok_or_else(|| Fail::new(2, "`surfaceUpdate` is required"))?;
                self.roer.save_piece(name, "surfaceUpdate", &surface.to_string())?;
                if let Some(data) = args.get("dataModelUpdate") {
                    self.roer.save_piece(name, "dataModelUpdate", &data.to_string())?;
                }
                if let Some(prompt) = args.get("prompt").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                    self.roer.save_piece(name, "prompt", prompt)?;
                }
                Ok(format!("Saved {name} under .roer/plugin-ui/bundles/{name}/."))
            }
            "load_ui" if self.here.is_some() => {
                let name = text(args, "name");
                self.roer.load_bundle(&self.pane(args)?, name)?;
                Ok(format!("Showing {name}."))
            }
            _ => Err(Fail::new(2, format!("unknown tool: {name}"))),
        }
    }

    /// The pane a tool acts on: the named session's, or this agent's own.
    fn pane(&self, args: &Value) -> Result<String, Fail> {
        match args.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(session) => {
                if !self.roer.tmux.has_session(session) {
                    return Err(Fail::new(3, format!("no Roer session named {session}")));
                }
                let pane = self.roer.tmux.active_pane(session);
                if pane.is_empty() {
                    return Err(Fail::new(3, format!("no pane in session {session}")));
                }
                Ok(pane)
            }
            None => self.here.clone().ok_or_else(|| Fail::new(2, "`session` is required outside a Roer session")),
        }
    }
}

fn text<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
