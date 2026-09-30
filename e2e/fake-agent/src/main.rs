//! `claude.exe` for the Windows e2e run: runs agent.mjs beside it with node,
//! passing everything on. An .exe because psmux defines a `claude` function in
//! its panes, for Claude Code's teammate mode, that calls `claude.exe`
//! whatever else is on PATH, and PowerShell prefers a function to any file.
//!
//! `ROER_E2E_AGENT` names agent.mjs and `ROER_E2E_NODE` node; a pane inherits
//! both from the app the harness started.
use std::process::{exit, Command};

fn main() {
    let agent = std::env::var_os("ROER_E2E_AGENT").unwrap_or_else(|| {
        eprintln!("fake claude: ROER_E2E_AGENT is not set");
        exit(2)
    });
    let node = std::env::var_os("ROER_E2E_NODE").unwrap_or_else(|| "node".into());
    match Command::new(&node).arg(agent).args(std::env::args_os().skip(1)).status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("fake claude: could not run {}: {e}", node.to_string_lossy());
            exit(1)
        }
    }
}
