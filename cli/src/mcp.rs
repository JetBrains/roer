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

use crate::records::{await_plugin_ui, Delivery};
use crate::{emit_plugin_ui, Fail, Roer};

/// What the Generative UI panel draws: the message kinds and the catalog.
const GUIDE: &str = include_str!("mcp-guide.md");

/// The protocol revisions this server speaks, newest last. It has no use for
/// anything newer than tools, so it answers each in kind.
const VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// `GUIDE`, as a resource: some clients truncate a long `instructions` string
/// before an agent ever sees the component catalog in it, and unlike
/// `instructions` a resource is read on demand, in full, as an ordinary tool
/// result. The name matches the `catalogId` in every `createSurface` example,
/// so a guess at reading "the catalog" lands on the real thing.
const CATALOG_URI: &str = "roer:catalog/1";

/// How to write an extension: `crate::ext::guide`, the guide and the API's types.
const EXTENSIONS_URI: &str = "roer:extensions/1";

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
                    "capabilities": { "tools": {}, "resources": {} },
                    "serverInfo": { "name": "roer", "version": env!("CARGO_PKG_VERSION") },
                });
                if !self.idle.get() {
                    reply["instructions"] = self.instructions().into();
                }
                result(id, reply)
            }
            "ping" => result(id, json!({})),
            "resources/list" => result(id, json!({ "resources": self.resources() })),
            "resources/read" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default();
                match self.read_resource(uri) {
                    Ok(contents) => result(id, json!({ "contents": [contents] })),
                    Err(fail) => error(id, -32602, &fail.message),
                }
            }
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

    /// Deliberately short: some clients cut a long `instructions` string
    /// partway through, so this only orients the agent and points it at
    /// `CATALOG_URI` for everything else — the message kinds in full, the
    /// whole component catalog and worked examples, which used to live here
    /// and so were the part a cut client never got to.
    fn instructions(&self) -> String {
        let scope = if self.here.is_some() {
            "This agent is running in a Roer session: `show_ui` and `read_ui_actions` act on it unless given \
             another `session`, `save_ui`/`load_ui` keep plugin UIs with this project, and `add_task`, \
             `update_task`, `list_tasks` and `delete_task` keep the user's personal tasks with it."
        } else {
            "This agent is not running in a Roer session, so each tool needs the `session` to act on: \
             the name Roer shows for it. Ask the user which session if they have not said."
        };
        format!(
            "{scope}\n\n\
             Roer's Generative UI: a panel beside a Roer session's terminal that draws UI from a small, \
             fixed catalog of trusted components, never from code you write. Every message is an envelope \
             with `\"version\": \"v1.0\"` and one body (`createSurface`, `updateComponents`, \
             `updateDataModel` or `deleteSurface`), naming the `surfaceId` it belongs to; pass them to \
             `show_ui`, which shows the panel itself once the first message arrives.\n\n\
             Before drafting anything, read the `{CATALOG_URI}` resource: it has the whole catalog, every \
             field, and worked examples, none of which fits here reliably. There is no escape hatch to \
             arbitrary markup, so whatever component you reach for is only documented there.\n\n\
             Extensions are the other way to put something on screen: a tab of its own in Roer's stage, \
             written in React, which stays there and stays live. Make one when the user asks for a tab or \
             a view they will keep coming back to. Read `{EXTENSIONS_URI}` (or call `describe_extension_api`) \
             before writing one, then load it with `extension_dev`."
        )
    }

    fn resources(&self) -> Vec<Value> {
        if self.idle.get() {
            return Vec::new();
        }
        vec![
            json!({
                "uri": CATALOG_URI,
                "name": "Generative UI guide",
                "description": "The A2UI v1.0 message kinds and the whole component catalog for show_ui, in full \
                    — read this if the server's instructions arrived cut short.",
                "mimeType": "text/markdown",
            }),
            json!({
                "uri": EXTENSIONS_URI,
                "name": "Extensions guide",
                "description": "How to write a Roer extension — a tab of its own in Roer's stage — and the whole \
                    API's types. Read it in full before writing one.",
                "mimeType": "text/markdown",
            }),
        ]
    }

    fn read_resource(&self, uri: &str) -> Result<Value, Fail> {
        if self.idle.get() {
            return Err(Fail::new(2, format!("no such resource: {uri}")));
        }
        match uri {
            CATALOG_URI => Ok(json!({ "uri": CATALOG_URI, "mimeType": "text/markdown", "text": GUIDE })),
            EXTENSIONS_URI => Ok(json!({ "uri": EXTENSIONS_URI, "mimeType": "text/markdown", "text": crate::ext::guide() })),
            _ => Err(Fail::new(2, format!("no such resource: {uri}"))),
        }
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
                "description": format!("Show or update a UI in a Roer session's Generative UI panel. `messages` is \
                    the sequence of A2UI v1.0 messages to send: usually one createSurface with the components and \
                    data model inline, later updateComponents / updateDataModel for the same surfaceId. The \
                    messages and the whole component catalog are in this server's instructions, and also as a \
                    resource ({CATALOG_URI}) if those arrived truncated."),
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
                    each an A2UI v1.0 action message on its own line, consumed as it is read. Empty when nothing \
                    was clicked.",
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
                        "surface": {
                            "type": "object",
                            "description": "One A2UI v1.0 createSurface message, components and data model inline.",
                        },
                        "prompt": { "type": "string", "description": "The request that produced it." },
                    },
                    "required": ["name", "surface"],
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
            let id = json!({ "type": "string", "description": "The task's id, like T-3." });
            let status = json!({ "type": "string", "enum": crate::tasks::STATUSES });
            let fields = json!({
                "title": { "type": "string" },
                "status": status,
                "body": { "type": "string", "description": "Longer notes. Empty clears them." },
                "labels": { "type": "array", "items": { "type": "string" }, "description": "Replaces the labels; [] clears them." },
            });
            let with_id = {
                let mut all = json!({ "id": id });
                all.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
                all
            };
            tools.push(json!({
                "name": "add_task",
                "description": "Add a personal task to this project's task store (.roer/tasks/), for the user or \
                    yourself to pick up later. Returns it with its id. Status starts as todo. To show it, \
                    draw it on a board with WorkItem (source \"personal\").",
                "inputSchema": { "type": "object", "properties": fields, "required": ["title"] },
            }));
            tools.push(json!({
                "name": "update_task",
                "description": "Change fields of a personal task — move it to doing or done, retitle it, relabel \
                    it. Only the fields given change. Returns the task.",
                "inputSchema": { "type": "object", "properties": with_id, "required": ["id"] },
            }));
            tools.push(json!({
                "name": "list_tasks",
                "description": "This project's personal tasks as a JSON array, oldest first, optionally only \
                    those with one status.",
                "inputSchema": { "type": "object", "properties": { "status": status } },
            }));
            tools.push(json!({
                "name": "delete_task",
                "description": "Delete a personal task. Prefer update_task with status done for finished work; \
                    delete one the user no longer wants at all.",
                "inputSchema": { "type": "object", "properties": { "id": id }, "required": ["id"] },
            }));
        }
        let folder = json!({
            "type": "string",
            "description": "The extension's folder, holding its extension.json; relative to the agent's working directory.",
        });
        let id = json!({ "type": "string", "description": "The extension's id, from its manifest." });
        tools.push(json!({
            "name": "describe_extension_api",
            "description": format!("How to write a Roer extension (a tab of its own in Roer's stage, in React) and the \
                whole API's types: the same as the {EXTENSIONS_URI} resource. Read it in full before writing one."),
            "inputSchema": { "type": "object", "properties": {} },
        }));
        tools.push(json!({
            "name": "extension_dev",
            "description": "Load an extension's folder into Roer as a session extension and wait for it: returns its \
                build errors and activation errors, or that its tab is up. Roer rebuilds and reloads it on every \
                save after that, until it restarts. Call it again after a fix to see how that build went.",
            "inputSchema": { "type": "object", "properties": { "dir": folder }, "required": ["dir"] },
        }));
        tools.push(json!({
            "name": "extension_install",
            "description": "Copy an extension's folder into ~/.roer/extensions, so Roer keeps it across restarts, \
                and wait for it to load. Do this once the user is happy with it.",
            "inputSchema": { "type": "object", "properties": { "dir": folder }, "required": ["dir"] },
        }));
        tools.push(json!({
            "name": "extension_logs",
            "description": "An extension's log, newest last: builds, activations, and what its tabs threw while rendering.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": id, "lines": { "type": "integer", "description": "How many of the last lines. Default 100." } },
                "required": ["id"],
            },
        }));
        tools.push(json!({
            "name": "list_extensions",
            "description": "The extensions Roer has, one per line: id, scope (session or user), ok or failed, folder.",
            "inputSchema": { "type": "object", "properties": {} },
        }));
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
                let mut ids = Vec::new();
                for (n, message) in messages.iter().enumerate() {
                    ids.push(emit_plugin_ui(&pane, message.clone(), n as u32 + 1)?);
                }
                delivered(&pane, &ids, &format!("{} message(s)", messages.len()))
            }
            "read_ui_actions" => Ok(Roer::take_actions(&self.pane(args)?)?.join("\n")),
            "describe_extension_api" => Ok(crate::ext::guide()),
            "extension_dev" | "extension_install" => {
                let dir = crate::ext::absolute(&self.roer.cwd, text(args, "dir"));
                let verb = if name == "extension_dev" { "dev" } else { "install" };
                crate::ext::act(verb, &dir)
            }
            "extension_logs" => {
                let lines = args.get("lines").and_then(Value::as_u64).unwrap_or(100) as usize;
                crate::ext::logs(text(args, "id"), lines)
            }
            "list_extensions" => Ok(crate::ext::list()),
            "save_ui" if self.here.is_some() => {
                let name = text(args, "name");
                let surface = args.get("surface").ok_or_else(|| Fail::new(2, "`surface` is required"))?;
                self.roer.save_piece(name, "surface", &surface.to_string())?;
                if let Some(prompt) = args.get("prompt").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                    self.roer.save_piece(name, "prompt", prompt)?;
                }
                Ok(format!("Saved {name} under .roer/plugin-ui/bundles/{name}/."))
            }
            "load_ui" if self.here.is_some() => {
                let name = text(args, "name");
                let pane = self.pane(args)?;
                let ids = self.roer.load_bundle(&pane, name)?;
                delivered(&pane, &ids, name)
            }
            "add_task" if self.here.is_some() => Ok(self.roer.tasks().add(args)?.to_string()),
            "update_task" if self.here.is_some() => {
                let mut fields = args.clone();
                let id = fields.as_object_mut().and_then(|f| f.remove("id"));
                let id = id.as_ref().and_then(Value::as_str).unwrap_or_default().to_string();
                Ok(self.roer.tasks().update(&id, &fields)?.to_string())
            }
            "list_tasks" if self.here.is_some() => {
                let status = args.get("status").and_then(Value::as_str).filter(|s| !s.is_empty());
                Ok(Value::Array(self.roer.tasks().list(status)?).to_string())
            }
            "delete_task" if self.here.is_some() => {
                let id = text(args, "id");
                self.roer.tasks().remove(id)?;
                Ok(format!("Deleted {id}."))
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

/// What to tell the agent about records sent to `pane`'s panel: that they
/// were shown, or why not. Every way a message can miss the panel is silent
/// on screen, so the agent is the only one who can be told, and the one who
/// can do something about it.
fn delivered(pane: &str, ids: &[String], what: &str) -> Result<String, Fail> {
    let Some(deliveries) = await_plugin_ui(ids) else {
        return Ok(format!("Sent {what} to the Generative UI panel."));
    };
    let again = "and send it again";
    for delivery in &deliveries {
        let problem = match delivery {
            Delivery::Unread => format!(
                "No Roer app picked this up, so nothing was shown. Ask the user to start Roer, open this session \
                 in it, {again}."
            ),
            Delivery::Answered { outcome, on_screen } => match outcome.as_str() {
                "shown" => continue,
                "other-pane" => format!(
                    "Roer is showing another session (pane {}), not this one ({pane}), so its panel ignored this. \
                     Ask the user to open this session in Roer, {again}.",
                    on_screen.as_deref().unwrap_or("unknown")
                ),
                "pane-unknown" => format!(
                    "Roer has a session on screen but does not know which pane it is, so its panel ignored this \
                     message for {pane}. Ask the user to reopen this session in Roer, from its session list or by \
                     running `roer` in its directory, {again}."
                ),
                "nothing-on-screen" => format!(
                    "Roer has no session on screen, so its panel ignored this. Ask the user to open this session \
                     ({pane}) in Roer, {again}."
                ),
                "invalid" => "Roer's panel rejected a message as not valid A2UI v1.0. Check it against the \
                              roer:catalog/1 resource."
                    .to_string(),
                other => format!("Roer's panel answered '{other}', which this roer does not know; ask the user whether it shows."),
            },
            Delivery::Taken => {
                return Ok(format!(
                    "Sent {what} to the Generative UI panel. This Roer does not confirm what it showed, so ask the \
                     user if the panel does not update."
                ))
            }
        };
        return Err(Fail::new(3, problem));
    }
    Ok(format!("Showing {what} in the Generative UI panel."))
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
