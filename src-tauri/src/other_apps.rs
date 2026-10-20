//! The apps that draw Roer's extensions outside Roer, as MCP Apps: the Claude
//! app and Codex. Connecting one registers `roer mcp` with it; from then on,
//! its chats can open the extensions whose manifest lists `"mcp-app"` in
//! `hosts` (`cli/src/mcp_apps.rs`). The Extensions dialog's "In other apps"
//! rows run these.
//!
//! `roer mcp install|uninstall|status --client <name>` owns what that means,
//! including leaving alone a `roer` entry the person wrote themselves; this
//! only runs it and reads back what it says.

use serde::Serialize;

use crate::claude_setup::roer;

/// The clients, by the name `roer mcp --client` knows them by, and the name the dialog shows.
const APPS: &[(&str, &str)] = &[("claude-desktop", "Claude app"), ("codex", "Codex")];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherApp {
    /// `roer mcp`'s name for it.
    pub id: String,
    pub name: String,
    /// `missing` (not on this machine), `connected` (roer's own entry), `theirs` (a `roer` entry the person
    /// wrote, which Roer leaves alone) or `off`.
    pub state: String,
    /// What its entry runs, when it has one.
    pub command: Option<String>,
    /// The config file the entry is in.
    pub config: Option<String>,
}

/// One line of `roer mcp status`: `name<TAB>state<TAB>config`, the state being `not found`, `registered: <cmd>`,
/// `not roer's: <cmd>`, `removed` or `not registered`.
fn parse(id: &str, name: &str, line: &str) -> OtherApp {
    let mut fields = line.trim_end().splitn(3, '\t');
    let _ = fields.next();
    let said = fields.next().unwrap_or_default();
    let config = fields.next().filter(|c| !c.is_empty()).map(str::to_string);
    let (state, command) = if said == "not found" {
        ("missing", None)
    } else if let Some(cmd) = said.strip_prefix("registered: ") {
        ("connected", Some(cmd))
    } else if let Some(cmd) = said.strip_prefix("not roer's: ") {
        ("theirs", Some(cmd))
    } else {
        ("off", None)
    };
    OtherApp { id: id.into(), name: name.into(), state: state.into(), command: command.map(str::to_string), config }
}

#[tauri::command(async)]
pub fn other_apps() -> Result<Vec<OtherApp>, String> {
    APPS.iter()
        .map(|(id, name)| roer(&["mcp", "status", "--client", id]).map(|out| parse(id, name, out.lines().next().unwrap_or_default())))
        .collect()
}

/// Connects the app, or disconnects it, and says how they all stand after.
#[tauri::command(async)]
pub fn other_app_connect(id: String, connect: bool) -> Result<Vec<OtherApp>, String> {
    if !APPS.iter().any(|(known, _)| *known == id) {
        return Err(format!("no such app: {id}"));
    }
    roer(&["mcp", if connect { "install" } else { "uninstall" }, "--client", &id])?;
    other_apps()
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reads_each_state_roer_mcp_status_reports() {
        let read = |line: &str| {
            let app = parse("codex", "Codex", line);
            (app.state, app.command, app.config)
        };
        assert_eq!(read("codex\tnot found\t/h/.codex/config.toml"), ("missing".into(), None, Some("/h/.codex/config.toml".into())));
        assert_eq!(read("codex\tregistered: /bin/roer\t/c"), ("connected".into(), Some("/bin/roer".into()), Some("/c".into())));
        assert_eq!(read("codex\tnot roer's: /mine/roer\t/c"), ("theirs".into(), Some("/mine/roer".into()), Some("/c".into())));
        assert_eq!(read("codex\tremoved\t/c").0, "off");
        assert_eq!(read("codex\tnot registered\t").0, "off");
        assert_eq!(read("").0, "off");
    }
}
