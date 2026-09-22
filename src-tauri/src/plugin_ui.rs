//! The terminal ↔ app plugin-UI channels.
//!
//! `roer plugin-ui` drops one A2UI-shaped message into ~/.roer/plugin-ui and
//! returns immediately — unlike a handoff, nothing is waiting on it, so there
//! is no claim, ack or timeout. This module only has to notice a new record,
//! hand its contents to the frontend, and forget it: consuming (deleting) the
//! file on delivery is what stands in for an ack here.
//!
//! Watching a directory rather than adding a Tauri command the shim calls
//! directly keeps the same shape as [`crate::handoff`] and works identically
//! whether the app is reached over `open -a Roer` or is already running.
//!
//! The reverse direction — a component's action, reported app → terminal —
//! is the same shape run backwards: [`report_plugin_ui_action`] writes a
//! record under ~/.roer/plugin-ui-actions, tagged with the pane, and
//! `roer plugin-ui-actions` polls and consumes whatever landed for its own
//! pane. There is deliberately no channel back into the app from there: an
//! action is a fact reported to whichever agent is watching that pane, not a
//! command Roer itself runs — the agent decides what, if anything, to do
//! about it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PLUGIN_UI_EVENT: &str = "roer://plugin-ui";

/// One A2UI-shaped message, tagged with the pane that sent it.
///
/// `message` is passed through untouched: its shape (`surfaceUpdate`,
/// `dataModelUpdate`, `beginRendering`) is the frontend's contract with the
/// agent, not this watcher's, so it travels as an opaque JSON value.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiRecord {
    pub pane: String,
    pub message: serde_json::Value,
}

/// Mirrors the shim's own resolution, `ROER_HOME` included.
pub fn plugin_ui_dir() -> PathBuf {
    roer_home().join("plugin-ui")
}

/// Where a reported action waits for `roer plugin-ui-actions` to collect it.
pub fn plugin_ui_actions_dir() -> PathBuf {
    roer_home().join("plugin-ui-actions")
}

fn roer_home() -> PathBuf {
    match std::env::var("ROER_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".roer"),
    }
}

/// A component's action, in the same shape A2UI's own client-to-server
/// `action` message uses: `name` and `sourceComponentId` say what was
/// triggered and by what, `context` carries whatever the component's
/// `action` bound from the data model, and this prototype tags the pane it
/// belongs to itself rather than making every plugin author repeat it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiAction {
    pub pane: String,
    #[serde(rename = "surfaceId")]
    pub surface_id: String,
    pub name: String,
    #[serde(rename = "sourceComponentId")]
    pub source_component_id: String,
    pub timestamp: String,
    #[serde(default)]
    pub context: serde_json::Value,
}

/// Report a component's action back to the terminal. Write-then-rename, the
/// same reasoning as the shim's own writes: `roer plugin-ui-actions` must
/// never observe a half-written record.
#[tauri::command]
pub fn report_plugin_ui_action(action: PluginUiAction) -> Result<(), String> {
    write_action(&action, &plugin_ui_actions_dir())
}

fn write_action(action: &PluginUiAction, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}-{}.json", unique_stamp(), std::process::id()));
    let partial = file.with_extension("json.partial");
    let body = serde_json::to_string(action).map_err(|e| e.to_string())?;
    std::fs::write(&partial, body).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &file).map_err(|e| e.to_string())
}

/// A unique, filesystem-sortable name for an action record. Nanoseconds
/// rather than the shim's second-resolution stamp: two clicks in the same
/// second must not collide before the pid is even considered.
fn unique_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
        .to_string()
}

fn is_record(path: &Path) -> bool {
    // The shim writes `<name>.json.partial` and renames it into place, so
    // filtering on the extension is also what keeps a partial record from
    // being parsed mid-write.
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

/// Start watching for plugin-UI messages.
///
/// Messages written while the app was down are lost, not queued — there is
/// no pending-fetch command to mirror `handoff_pending`. That is deliberate:
/// a plugin's UI is only ever generated while a session is on screen and an
/// agent is being asked for it, so the app is already up by construction.
pub fn watch(app: AppHandle) -> notify::Result<()> {
    let dir = plugin_ui_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("roer: cannot create {}: {e}", dir.display());
        return Ok(());
    }

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("roer: could not start the plugin-ui watcher: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("roer: could not watch {}: {e}", dir.display());
            return;
        }

        // One rename can surface as several events, so records are delivered
        // once. Entries for files that are gone are dropped first, which both
        // bounds the set and lets a recycled filename through.
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for event in rx.into_iter().flatten() {
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            seen.retain(|path| path.exists());
            for path in event.paths {
                if is_record(&path) && path.exists() && seen.insert(path.clone()) {
                    deliver(&app, &path);
                }
            }
        }
    });

    Ok(())
}

fn deliver(app: &AppHandle, path: &Path) {
    match read(path) {
        Ok(record) => {
            if let Err(e) = app.emit(PLUGIN_UI_EVENT, record) {
                eprintln!("roer: could not deliver a plugin-ui message: {e}");
            }
        }
        // A malformed record must not take the watcher down with it.
        Err(e) => eprintln!("roer: ignoring {}: {e}", path.display()),
    }
    // Fire-and-forget: nothing acks this, so delivering it is the last thing
    // that happens to the file. Leaving it behind would mean the watcher
    // re-delivers on every subsequent event within its `seen` window, or the
    // directory grows without bound across a long session.
    let _ = std::fs::remove_file(path);
}

fn read(path: &Path) -> Result<PluginUiRecord, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// A saved plugin UI: the prompt that produced it, plus the exact
/// `surfaceUpdate`/`dataModelUpdate` messages that build it — the same
/// messages `roer plugin-ui` already knows how to carry, kept opaque here for
/// the same reason [`PluginUiRecord::message`] is: this module doesn't know
/// or care about the A2UI component catalog, only the frontend does.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiBundle {
    pub prompt: String,
    #[serde(rename = "surfaceUpdate")]
    pub surface_update: serde_json::Value,
    #[serde(rename = "dataModelUpdate", skip_serializing_if = "Option::is_none")]
    pub data_model_update: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginUiBundleSummary {
    pub name: String,
    pub prompt: String,
}

/// The worktree root holding `cwd`, falling back to `cwd` itself outside a
/// repository — a roer session is always opened at a project directory, so
/// this is a reasonable place to keep bundles even without git.
fn project_root(cwd: &str) -> PathBuf {
    crate::git::root(cwd)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(cwd))
}

fn bundles_dir(cwd: &str) -> PathBuf {
    project_root(cwd).join(".roer").join("plugin-ui").join("bundles")
}

/// A bundle name becomes a single path segment on disk, so it must not be
/// empty or carry any path structure of its own — a `../x` here must never
/// escape `bundles_dir`.
fn validate_bundle_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid plugin-ui bundle name: {name:?} (use letters, digits, - and _ only)"
        ))
    }
}

fn write_string(path: &Path, contents: &str) -> Result<(), String> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_plugin_ui_bundles(cwd: String) -> Vec<PluginUiBundleSummary> {
    let dir = bundles_dir(&cwd);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut bundles: Vec<PluginUiBundleSummary> = entries
        .flatten()
        .filter(|entry| entry.path().join("surface-update.json").is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let prompt = std::fs::read_to_string(entry.path().join("prompt.md")).unwrap_or_default();
            Some(PluginUiBundleSummary { name, prompt })
        })
        .collect();
    bundles.sort_by(|a, b| a.name.cmp(&b.name));
    bundles
}

#[tauri::command]
pub fn read_plugin_ui_bundle(cwd: String, name: String) -> Result<PluginUiBundle, String> {
    validate_bundle_name(&name)?;
    let dir = bundles_dir(&cwd).join(&name);
    let surface_update = read_json(&dir.join("surface-update.json"))?;
    let data_model_update = read_json(&dir.join("data-model.json")).ok();
    let prompt = std::fs::read_to_string(dir.join("prompt.md")).unwrap_or_default();
    Ok(PluginUiBundle {
        prompt,
        surface_update,
        data_model_update,
    })
}

#[tauri::command]
pub fn write_plugin_ui_bundle(
    cwd: String,
    name: String,
    bundle: PluginUiBundle,
) -> Result<(), String> {
    validate_bundle_name(&name)?;
    let dir = bundles_dir(&cwd).join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_string(&dir.join("prompt.md"), &bundle.prompt)?;
    write_string(
        &dir.join("surface-update.json"),
        &serde_json::to_string_pretty(&bundle.surface_update).map_err(|e| e.to_string())?,
    )?;
    match &bundle.data_model_update {
        Some(patch) => write_string(
            &dir.join("data-model.json"),
            &serde_json::to_string_pretty(patch).map_err(|e| e.to_string())?,
        )?,
        None => {
            let _ = std::fs::remove_file(dir.join("data-model.json"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_records_are_picked_up() {
        assert!(is_record(Path::new("/tmp/p/20260101T000000-1.json")));
        assert!(!is_record(Path::new(
            "/tmp/p/20260101T000000-1.json.partial"
        )));
        assert!(!is_record(Path::new("/tmp/p/notes.txt")));
    }

    #[test]
    fn reads_a_message_and_keeps_it_opaque() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("20260101T000000-1.json");
        std::fs::write(
            &path,
            r#"{"pane": "%3", "message": {"kind": "beginRendering", "surfaceId": "s"}}"#,
        )
        .expect("write record");

        let got = read(&path).expect("parse");
        assert_eq!(got.pane, "%3");
        assert_eq!(got.message["kind"], "beginRendering");
        assert_eq!(got.message["surfaceId"], "s");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_record_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("bad.json");
        std::fs::write(&path, "{ not json").expect("write");
        assert!(read(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_action_lands_as_one_complete_json_file() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-actions-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();

        let action = PluginUiAction {
            pane: "%9".into(),
            surface_id: "catalog-demo".into(),
            name: "run".into(),
            source_component_id: "run-button".into(),
            timestamp: "2026-09-22T00:00:00Z".into(),
            context: serde_json::json!({}),
        };
        write_action(&action, &dir).expect("write");

        let entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .map(|e| e.expect("entry").path())
            .collect();
        // Never a `.partial` left behind, and never more than the one record.
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].extension().and_then(|e| e.to_str()), Some("json"));

        let raw = std::fs::read_to_string(&entries[0]).expect("read");
        let got: PluginUiAction = serde_json::from_str(&raw).expect("parse");
        assert_eq!(got.pane, "%9");
        assert_eq!(got.name, "run");
        assert_eq!(got.source_component_id, "run-button");

        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp_project(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "roer-plugin-ui-bundles-{label}-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn rejects_names_that_are_not_a_single_path_segment() {
        assert!(validate_bundle_name("test-runner").is_ok());
        assert!(validate_bundle_name("").is_err());
        assert!(validate_bundle_name("..").is_err());
        assert!(validate_bundle_name("../x").is_err());
        assert!(validate_bundle_name("a/b").is_err());
    }

    #[test]
    fn a_bundle_round_trips_through_write_and_read() {
        let project = temp_project("roundtrip");
        let cwd = project.to_str().unwrap().to_string();

        let bundle = PluginUiBundle {
            prompt: "Add a test runner".into(),
            surface_update: serde_json::json!({
                "kind": "surfaceUpdate",
                "surfaceId": "test-runner",
                "root": "card",
                "components": [{"id": "card", "type": "Card", "children": []}],
            }),
            data_model_update: Some(serde_json::json!({
                "kind": "dataModelUpdate",
                "surfaceId": "test-runner",
                "patch": {"status": "idle"},
            })),
        };
        write_plugin_ui_bundle(cwd.clone(), "test-runner".into(), bundle.clone())
            .expect("write bundle");

        let got = read_plugin_ui_bundle(cwd.clone(), "test-runner".into()).expect("read bundle");
        assert_eq!(got.prompt, bundle.prompt);
        assert_eq!(got.surface_update, bundle.surface_update);
        assert_eq!(got.data_model_update, bundle.data_model_update);

        let bundles = list_plugin_ui_bundles(cwd);
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].name, "test-runner");
        assert_eq!(bundles[0].prompt, "Add a test runner");

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn a_bundle_without_a_data_model_update_omits_the_file() {
        let project = temp_project("no-data-model");
        let cwd = project.to_str().unwrap().to_string();

        write_plugin_ui_bundle(
            cwd.clone(),
            "static".into(),
            PluginUiBundle {
                prompt: "A static banner".into(),
                surface_update: serde_json::json!({"kind": "surfaceUpdate"}),
                data_model_update: None,
            },
        )
        .expect("write bundle");

        assert!(!bundles_dir(&cwd).join("static").join("data-model.json").exists());
        let got = read_plugin_ui_bundle(cwd, "static".into()).expect("read bundle");
        assert_eq!(got.data_model_update, None);

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn listing_skips_directories_with_no_surface_update() {
        let project = temp_project("skip-incomplete");
        let cwd = project.to_str().unwrap().to_string();
        std::fs::create_dir_all(bundles_dir(&cwd).join("half-written")).expect("mkdir");

        assert!(list_plugin_ui_bundles(cwd).is_empty());

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn a_traversal_attempt_in_the_name_is_rejected_before_touching_disk() {
        let project = temp_project("traversal");
        let cwd = project.to_str().unwrap().to_string();

        let err = write_plugin_ui_bundle(
            cwd,
            "../escaped".into(),
            PluginUiBundle {
                prompt: String::new(),
                surface_update: serde_json::json!({}),
                data_model_update: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("invalid plugin-ui bundle name"));
        assert!(!project.parent().unwrap().join("escaped").exists());

        std::fs::remove_dir_all(&project).ok();
    }
}
