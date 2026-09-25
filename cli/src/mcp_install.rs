//! `roer mcp install|uninstall|status`: registers `roer mcp` with the MCP
//! clients on this machine, the way `roer skills` installs skills and on the
//! same terms. Claude Code only, unless `--client claude-desktop` asks for the
//! Claude app too: it is not offered there yet, so neither the app's launch
//! nor a plain `roer mcp install` touches the Claude app's config.
//!
//! What roer registered is written down under `$ROER_HOME/mcp`, with the
//! command it registered, and only an entry still exactly that is ever
//! changed or removed: a `roer` entry the person wrote or edited is theirs.
//! The app runs `install --auto` on every launch, which never registers roer
//! where it was not registered before (the app asks first, then runs
//! `install`), and also keeps out of a client once the person has taken the
//! entry away there.
//!
//! Claude Code is changed through its own `claude mcp`, never by writing its
//! `.claude.json`, which it rewrites constantly; roer only reads it. The
//! Claude app has no such command, so its config file is edited directly,
//! keeping everything else in it as it was.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Map, Value};

use crate::{records, Fail, Outcome};

pub fn run(args: &[&str]) -> Outcome {
    let (sub, rest) = args.split_first().map_or(("status", &[][..]), |(sub, rest)| (*sub, rest));
    let mut only = None;
    let mut auto = false;
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        match *arg {
            "--client" => only = Some(*rest.next().ok_or_else(|| Fail::new(64, "--client needs a name"))?),
            "--auto" if sub == "install" => auto = true,
            other => return Err(Fail::new(64, format!("unexpected argument: {other}"))),
        }
    }
    let clients = match only {
        Some(name) => vec![Client::named(name)?],
        None => vec![Client::ClaudeCode],
    };
    let me = crate::self_path().to_string_lossy().into_owned();
    for client in clients {
        let outcome = match sub {
            "install" if auto => client.auto(&me),
            "install" => client.install(&me),
            "uninstall" => client.uninstall(),
            "status" => client.status(),
            other => return Err(Fail::new(64, format!("unknown mcp command: {other}"))),
        };
        // One client's trouble is no reason to skip the next.
        if let Err(fail) = outcome {
            eprintln!("roer: {}: {}", client.name(), fail.message);
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Client {
    ClaudeCode,
    ClaudeDesktop,
}

impl Client {
    fn named(name: &str) -> Result<Self, Fail> {
        match name {
            "claude-code" => Ok(Client::ClaudeCode),
            "claude-desktop" => Ok(Client::ClaudeDesktop),
            other => Err(Fail::new(64, format!("unknown client: {other} (known: claude-code, claude-desktop)"))),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude-code",
            Client::ClaudeDesktop => "claude-desktop",
        }
    }

    /// `roer mcp install`: registers roer, taking back an earlier uninstall.
    fn install(self, me: &str) -> Outcome {
        self.forget("declined")?;
        if !self.present() {
            println!("{}: not found on this machine", self.name());
            return Ok(());
        }
        match (self.recorded(), self.entry()?) {
            (Some(ours), Some(entry)) if ours == entry && entry == me => println!("{}: up to date", self.name()),
            (Some(ours), Some(entry)) if ours == entry => {
                self.register(me, true)?;
                println!("{}: updated", self.name());
            }
            (_, Some(_)) => println!("{}: left its roer entry alone, it is not one roer made", self.name()),
            (_, None) => {
                self.register(me, false)?;
                println!("{}: registered{}", self.name(), self.restart_note());
            }
        }
        Ok(())
    }

    /// What the app runs on launch: keeps roer's own entry pointing at this
    /// roer, and never registers it where it has not been, brings back what
    /// the person removed, or overrides what they changed.
    fn auto(self, me: &str) -> Outcome {
        if self.path("declined").exists() || !self.present() {
            return Ok(());
        }
        match (self.recorded(), self.entry()?) {
            (Some(_), None) => {
                self.forget("installed")?;
                self.write("declined", "")?;
            }
            (Some(ours), Some(entry)) if ours == entry => {
                if entry != me {
                    self.register(me, true)?;
                }
            }
            (Some(_), Some(_)) => self.forget("installed")?,
            (None, _) => {}
        }
        Ok(())
    }

    /// `roer mcp uninstall`: removes roer's own entry, and keeps the app from
    /// registering it again until `roer mcp install`.
    fn uninstall(self) -> Outcome {
        if self.present() {
            if let (Some(ours), Some(entry)) = (self.recorded(), self.entry()?) {
                if ours == entry {
                    self.unregister()?;
                    println!("{}: unregistered", self.name());
                }
            }
        }
        self.forget("installed")?;
        self.write("declined", "")?;
        println!("{}: Roer will not register itself again; `roer mcp install` brings it back.", self.name());
        Ok(())
    }

    fn status(self) -> Outcome {
        let state = if !self.present() {
            "not found".to_string()
        } else {
            match (self.recorded(), self.entry()?) {
                (Some(ours), Some(entry)) if ours == entry => format!("registered: {entry}"),
                (_, Some(entry)) => format!("not roer's: {entry}"),
                _ if self.path("declined").exists() => "removed".to_string(),
                _ => "not registered".to_string(),
            }
        };
        println!("{}\t{state}\t{}", self.name(), self.config().map(|p| p.display().to_string()).unwrap_or_default());
        Ok(())
    }

    /// Whether the client is installed: without it, there is nothing to
    /// register with, and no directory is made for it.
    fn present(self) -> bool {
        match self {
            Client::ClaudeCode => claude_root().is_dir() && claude_bin().is_some(),
            Client::ClaudeDesktop => self.config().and_then(|p| p.parent().map(Path::is_dir)).unwrap_or(false),
        }
    }

    fn config(self) -> Option<PathBuf> {
        match self {
            Client::ClaudeCode => Some(match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
                Some(dir) => PathBuf::from(dir).join(".claude.json"),
                None => records::user_home().join(".claude.json"),
            }),
            Client::ClaudeDesktop => {
                let dir = if cfg!(target_os = "macos") {
                    records::user_home().join("Library/Application Support/Claude")
                } else if cfg!(windows) {
                    PathBuf::from(std::env::var_os("APPDATA")?).join("Claude")
                } else {
                    return None;
                };
                Some(dir.join("claude_desktop_config.json"))
            }
        }
    }

    /// The command of the client's `roer` entry, if it has one; empty for an
    /// entry that is not a plain `<command> mcp`, which is never roer's.
    fn entry(self) -> Result<Option<String>, Fail> {
        let Some(servers) = self.read_config()?.get("mcpServers").and_then(|s| s.get("roer")).cloned() else {
            return Ok(None);
        };
        let plain = servers.get("args") == Some(&json!(["mcp"]));
        let command = servers.get("command").and_then(Value::as_str).filter(|_| plain).unwrap_or_default();
        Ok(Some(command.to_owned()))
    }

    fn read_config(self) -> Result<Value, Fail> {
        let Some(path) = self.config() else { return Ok(json!({})) };
        match std::fs::read_to_string(&path) {
            Ok(text) if text.trim().is_empty() => Ok(json!({})),
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| Fail::new(1, format!("{} is not JSON, so it is left as it is: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(e) => Err(Fail::new(1, format!("could not read {}: {e}", path.display()))),
        }
    }

    /// Points the client's `roer` entry at `me`, replacing roer's old one.
    fn register(self, me: &str, replacing: bool) -> Outcome {
        let server = json!({ "type": "stdio", "command": me, "args": ["mcp"] });
        match self {
            Client::ClaudeCode => {
                if replacing {
                    claude(&["mcp", "remove", "--scope", "user", "roer"])?;
                }
                claude(&["mcp", "add-json", "--scope", "user", "roer", &server.to_string()])?;
            }
            Client::ClaudeDesktop => self.edit_desktop(|servers| {
                servers.insert("roer".into(), json!({ "command": me, "args": ["mcp"] }));
            })?,
        }
        self.write("installed", me)
    }

    fn unregister(self) -> Outcome {
        match self {
            Client::ClaudeCode => claude(&["mcp", "remove", "--scope", "user", "roer"]),
            Client::ClaudeDesktop => self.edit_desktop(|servers| {
                servers.remove("roer");
            }),
        }
    }

    /// Changes the Claude app's `mcpServers`, everything else in its config
    /// kept as it was, in its order.
    fn edit_desktop(self, change: impl FnOnce(&mut Map<String, Value>)) -> Outcome {
        let path = self.config().ok_or_else(|| Fail::new(1, "the Claude app has no config on this platform"))?;
        let mut config = self.read_config()?;
        let root = config.as_object_mut().ok_or_else(|| Fail::new(1, format!("{} is not an object", path.display())))?;
        let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
        let servers =
            servers.as_object_mut().ok_or_else(|| Fail::new(1, format!("mcpServers in {} is not an object", path.display())))?;
        change(servers);
        let text = serde_json::to_string_pretty(&config).unwrap_or_default();
        records::write_atomic(&path, &format!("{text}\n"))
    }

    fn restart_note(self) -> &'static str {
        match self {
            Client::ClaudeCode => "; new Claude Code sessions have it",
            Client::ClaudeDesktop => "; restart the Claude app to use it",
        }
    }

    fn path(self, what: &str) -> PathBuf {
        records::home().join("mcp").join(format!("{}-{what}", self.name()))
    }

    fn recorded(self) -> Option<String> {
        std::fs::read_to_string(self.path("installed")).ok().map(|text| text.trim_end().to_owned())
    }

    fn write(self, what: &str, text: &str) -> Outcome {
        let path = self.path(what);
        let dir = path.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(dir).map_err(|e| Fail::new(1, format!("could not create {}: {e}", dir.display())))?;
        records::write_atomic(&path, text)
    }

    fn forget(self, what: &str) -> Outcome {
        let path = self.path(what);
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(Fail::new(1, format!("could not remove {}: {e}", path.display())))
            }
            _ => Ok(()),
        }
    }
}

fn claude_root() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| records::user_home().join(".claude"))
}

/// Claude Code's `claude`: on `PATH`, or where its installers put it, since
/// the app runs this with Finder's bare `PATH`.
fn claude_bin() -> Option<PathBuf> {
    let name = if cfg!(windows) { "claude.exe" } else { "claude" };
    let home = records::user_home();
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).map(|dir| dir.join(name)).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain([
            home.join(".local/bin").join(name),
            home.join(".claude/local").join(name),
            PathBuf::from("/opt/homebrew/bin").join(name),
            PathBuf::from("/usr/local/bin").join(name),
        ])
        .find(|path| path.is_file())
}

fn claude(args: &[&str]) -> Outcome {
    let bin = claude_bin().ok_or_else(|| Fail::new(1, "claude not found"))?;
    let out = Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Fail::new(1, format!("could not run {}: {e}", bin.display())))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(Fail::new(1, format!("claude {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim())))
    }
}
