//! The agents a new session can start, through `roer agents`: the shim owns
//! the files, the defaults and each CLI's flags, so the app and a terminal
//! always agree on what an agent runs.

use std::io::Write;
use std::process::Stdio;

use serde_json::Value;

use crate::roer::bin;

/// Runs `roer agents <args>` in `cwd`, whose project's own agents are listed
/// beside the person's, with `input` on stdin.
fn agents(cwd: Option<&str>, args: &[&str], input: Option<&str>) -> Result<String, String> {
    let mut command = crate::process::command(bin());
    command.arg("agents").args(args);
    if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty() && std::path::Path::new(cwd).is_dir()) {
        command.current_dir(cwd).env("PWD", cwd);
    }
    let mut child = command
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run `{} agents`: {e}", bin()))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(input.as_bytes()).map_err(|e| format!("could not write to `roer agents`: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("could not wait for `roer agents`: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("roer: ").to_string())
    }
}

fn json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("`roer agents` printed something other than JSON: {e}"))
}

/// Every agent, the CLIs and which are installed, and the defaults.
#[tauri::command(async)]
pub fn agents_list(cwd: Option<String>) -> Result<Value, String> {
    json(&agents(cwd.as_deref(), &["list", "--json"], None)?)
}

#[tauri::command(async)]
pub fn agent_save(cwd: Option<String>, agent: Value, scope: String, from: Option<String>) -> Result<Value, String> {
    let mut args = vec!["save", "--scope", scope.as_str()];
    if let Some(from) = from.as_deref().filter(|from| !from.is_empty()) {
        args.extend(["--from", from]);
    }
    json(&agents(cwd.as_deref(), &args, Some(&agent.to_string()))?)
}

#[tauri::command(async)]
pub fn agent_remove(cwd: Option<String>, id: String, scope: String) -> Result<(), String> {
    agents(cwd.as_deref(), &["rm", &id, "--scope", &scope], None).map(|_| ())
}

/// `id: None` clears the default for `scope`.
#[tauri::command(async)]
pub fn agent_set_default(cwd: Option<String>, id: Option<String>, scope: String) -> Result<(), String> {
    let id = id.unwrap_or_else(|| "--clear".to_string());
    agents(cwd.as_deref(), &["default", &id, "--scope", &scope], None).map(|_| ())
}

/// The line an agent, saved or not, would type into its session.
#[tauri::command(async)]
pub fn agent_command(agent: Value) -> Result<String, String> {
    agents(None, &["command"], Some(&agent.to_string()))
}

#[tauri::command(async)]
pub fn agent_models(cli: String) -> Vec<String> {
    agents(None, &["models", &cli], None)
        .map(|out| out.lines().map(str::to_string).filter(|line| !line.is_empty()).collect())
        .unwrap_or_default()
}
