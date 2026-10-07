//! Setting Roer up in Claude Code, which the person says yes to rather than
//! finding done: Roer's skills (`/roer-handoff`) and its MCP server. The app
//! asks once, on the first launch that finds Claude Code, and the menu's
//! "Claude Code Integration…" opens the same choice again, to set up later or
//! take back.
//!
//! `roer skills` and `roer mcp` own what installing means; this only runs
//! them and reads back what they say. The launch's `install --auto` keeps an
//! existing setup pointing at this app but never makes a first one.

use std::process::Stdio;

use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    /// Whether Claude Code is on this machine at all: without it there is
    /// nothing to set up.
    pub claude_code: bool,
    /// Roer's skills are in `~/.claude/skills`.
    pub skills: bool,
    /// `roer mcp` is registered with Claude Code.
    pub mcp: bool,
    /// Whether to ask on this launch: Claude Code is here, and nothing about
    /// Roer in it has been decided yet, here or on the command line.
    pub should_prompt: bool,
}

/// Written once the person has answered, either way, so the question is not
/// put again at the next launch.
fn asked_record() -> std::path::PathBuf {
    crate::history::roer_home().join("claude-setup-asked")
}

#[tauri::command(async)]
pub fn claude_setup_status() -> Result<SetupStatus, String> {
    let mcp = roer(&["mcp", "status"])?;
    let skills = roer(&["skills", "list", "--agent", "claude"])?;
    Ok(status(&mcp, &skills, asked_record().exists()))
}

/// Makes Claude Code have what the person ticked, and nothing they did not:
/// an untick is `uninstall`, which also keeps the launch from redoing it.
#[tauri::command(async)]
pub fn claude_setup_apply(skills: bool, mcp: bool) -> Result<SetupStatus, String> {
    roer(&["skills", if skills { "install" } else { "uninstall" }, "--agent", "claude"])?;
    roer(&["mcp", if mcp { "install" } else { "uninstall" }])?;
    mark_asked()?;
    claude_setup_status()
}

/// "Not now": nothing is installed or removed, and the menu is where to find
/// the choice again.
#[tauri::command(async)]
pub fn claude_setup_dismiss() -> Result<(), String> {
    mark_asked()
}

fn mark_asked() -> Result<(), String> {
    let path = asked_record();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, "").map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Reads `roer mcp status` and `roer skills list`, one tab-separated row per
/// client or skill: the name, then its state.
fn status(mcp: &str, skills: &str, asked: bool) -> SetupStatus {
    let mcp_state = mcp
        .lines()
        .filter_map(|line| line.split('\t').nth(1).filter(|_| line.starts_with("claude-code\t")))
        .next()
        .unwrap_or("not found");
    let skill_states: Vec<&str> =
        skills.lines().filter_map(|line| line.split('\t').nth(1)).collect();
    let claude_code = mcp_state != "not found";
    let skills_on = !skill_states.is_empty()
        && skill_states.iter().all(|state| matches!(*state, "installed" | "outdated"));
    let mcp_on = mcp_state.starts_with("registered");
    // Anything other than "never touched" is a decision already made: an
    // install from the command line, an uninstall, or an older app that
    // installed without asking.
    let untouched = mcp_state == "not registered"
        && skill_states.iter().all(|state| *state == "not installed")
        && !skills.contains("will not install");
    SetupStatus {
        claude_code,
        skills: skills_on,
        mcp: mcp_on,
        should_prompt: claude_code && !asked && untouched,
    }
}

fn roer(args: &[&str]) -> Result<String, String> {
    let bin = crate::roer::bin();
    let out = crate::process::command(&bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run `{bin} {}`: {e}", args.join(" ")))?;
    // `roer mcp` reports one client's trouble on stderr and carries on, so
    // the exit status alone would hide it.
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() || !stderr.is_empty() {
        return Err(if stderr.is_empty() { format!("`roer {}` failed", args.join(" ")) } else { stderr });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::status;

    const FRESH_SKILLS: &str = "roer-handoff\tnot installed\t/Users/me/.claude/skills/roer-handoff\n";

    #[test]
    fn asks_a_machine_with_claude_code_where_nothing_is_decided() {
        let got = status("claude-code\tnot registered\t/Users/me/.claude.json\n", FRESH_SKILLS, false);
        assert!(got.claude_code && got.should_prompt);
        assert!(!got.skills && !got.mcp);
    }

    #[test]
    fn never_asks_without_claude_code_or_once_answered() {
        assert!(!status("claude-code\tnot found\t\n", FRESH_SKILLS, false).should_prompt);
        assert!(!status("claude-code\tnot registered\t\n", FRESH_SKILLS, true).should_prompt);
    }

    #[test]
    fn an_earlier_install_or_uninstall_counts_as_an_answer() {
        let installed = status(
            "claude-code\tregistered: /Applications/Roer.app/Contents/MacOS/roer\t\n",
            "roer-handoff\tinstalled\t/x\n",
            false,
        );
        assert!(installed.skills && installed.mcp && !installed.should_prompt);

        let removed = status("claude-code\tremoved\t\n", FRESH_SKILLS, false);
        assert!(!removed.mcp && !removed.should_prompt);

        let declined = status(
            "claude-code\tnot registered\t\n",
            "roer-handoff\tnot installed\t/x\nThe app will not install these for claude; `roer skills install` turns that back on.\n",
            false,
        );
        assert!(!declined.should_prompt);
    }
}
